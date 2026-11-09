package service

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"waterlog-v3/api/internal/domain"
	"waterlog-v3/api/internal/store"
)

// 内置渠道名。
//
// inapp 永远启用且不可关闭：它是"最后一定会到达"的那条路。关掉站内只留
// webhook，等于把预警的可靠性押在第三方可用性上——而预警系统最不该做的
// 事就是把"有没有通知到"变成别人服务的问题。
const (
	ChannelInApp   = "inapp"
	ChannelWebhook = "webhook"
)

// builtinChannels 是首次启动时写入数据库的默认配置。
//
// 放在 service 而不是 SQL 迁移里：迁移文件是一次性的，而这里要表达的是
// "系统支持哪些渠道"这个持续的事实。
var builtinChannels = []domain.NotifyChannel{
	{Name: ChannelInApp, Enabled: true, MinLevel: "blue", DebounceMin: 0},
	{Name: ChannelWebhook, Enabled: false, MinLevel: "orange", DebounceMin: 15},
}

// Notifier 负责把"预警升起/升级"推给各渠道。
//
// 它刻意不重试：预警的价值在及时，不在最终一致。一次失败就记一条
// notify_delivery(ok=0)，让值班员在系统页看到"这条没推出去"，
// 比在后台排队重试十分钟更符合预警系统的心智。
type Notifier struct {
	store *store.Store
	log   *slog.Logger
	http  *http.Client

	mu   sync.Mutex
	last map[string]int64 // "channel|site" → 上次推送的仿真时刻
}

// NewNotifier 构造推送器。
func NewNotifier(st *store.Store, log *slog.Logger) *Notifier {
	return &Notifier{
		store: st,
		log:   log,
		http:  &http.Client{Timeout: 4 * time.Second},
		last:  map[string]int64{},
	}
}

// EnsureChannels 补齐内置渠道行（幂等）。
func (n *Notifier) EnsureChannels(now int64) {
	existing := map[string]bool{}
	if rows, err := n.store.NotifyChannels(); err == nil {
		for _, c := range rows {
			existing[c.Name] = true
		}
	}
	for _, c := range builtinChannels {
		if existing[c.Name] {
			continue
		}
		c.UpdatedAt = now
		if err := n.store.UpsertNotifyChannel(c); err != nil {
			n.log.Warn("初始化推送渠道失败", "channel", c.Name, "err", err)
		}
	}
}

// Channels 返回渠道配置（secret 已打码，可直接给前端）。
func (n *Notifier) Channels() ([]domain.NotifyChannel, error) {
	rows, err := n.store.NotifyChannels()
	if err != nil {
		return nil, err
	}
	for i := range rows {
		rows[i].Secret = maskSecret(rows[i].Secret)
	}
	return rows, nil
}

// UpdateChannel 改渠道配置。传空 secret 表示"保持原值不变"，
// 因为前端拿到的是打码串，回传打码串会把真密钥覆盖成 "ab****yz"。
func (n *Notifier) UpdateChannel(c domain.NotifyChannel, now int64) (*domain.NotifyChannel, error) {
	cur, err := n.store.NotifyChannel(c.Name)
	if err != nil {
		return nil, notFound("未知渠道：%s", c.Name)
	}
	if !validLevelOrEmpty(c.MinLevel) {
		return nil, badRequest("min_level 只能是 blue / yellow / orange / red")
	}
	if c.DebounceMin < 0 || c.DebounceMin > 1440 {
		return nil, badRequest("debounce_min 需在 0~1440 之间")
	}
	if c.Enabled && c.Name != ChannelInApp && strings.TrimSpace(c.Endpoint) == "" {
		return nil, badRequest("启用 %s 渠道需要填写 endpoint", c.Name)
	}

	out := *cur
	out.Enabled = c.Enabled
	out.MinLevel = c.MinLevel
	out.DebounceMin = c.DebounceMin
	out.Endpoint = strings.TrimSpace(c.Endpoint)
	if s := strings.TrimSpace(c.Secret); s != "" && !strings.Contains(s, "****") {
		out.Secret = s
	}
	if c.Name == ChannelInApp {
		// 站内渠道不允许关闭：见文件头注释
		out.Enabled = true
	}
	out.UpdatedAt = now
	if err := n.store.UpsertNotifyChannel(out); err != nil {
		return nil, internal(err)
	}
	out.Secret = maskSecret(out.Secret)
	return &out, nil
}

// Deliveries 返回推送记录。
func (n *Notifier) Deliveries(limit int) ([]domain.Delivery, error) {
	return n.store.Deliveries(limit)
}

// NotifyWarning 把一次预警变更推给所有已达门槛的渠道。
//
// 只在 raised / upgraded 时推：updated 是"还在预警中"，每轮都推会变成
// 每 60 秒一条的骚扰，值班员很快就会把通知关掉——那比不推更危险。
func (n *Notifier) NotifyWarning(ev *domain.WarningEvent, action string, now int64) {
	if ev == nil || (action != "raised" && action != "upgraded") {
		return
	}
	channels, err := n.store.NotifyChannels()
	if err != nil {
		n.log.Warn("读取推送渠道失败", "err", err)
		return
	}
	rank := domain.LevelRankOf(ev.Level)
	for _, c := range channels {
		if !c.Enabled {
			continue
		}
		if rank < domain.LevelRankOf(c.MinLevel) {
			continue
		}
		if c.Name != ChannelInApp && c.DebounceMin > 0 {
			key := c.Name + "|" + ev.SiteID
			n.mu.Lock()
			prev, seen := n.last[key]
			if seen && now-prev < int64(c.DebounceMin)*60 {
				n.mu.Unlock()
				continue
			}
			n.last[key] = now
			n.mu.Unlock()
		}
		n.deliver(c, ev, action, now)
	}
}

// deliver 执行一次推送并落记录。
func (n *Notifier) deliver(c domain.NotifyChannel, ev *domain.WarningEvent, action string, now int64) {
	d := domain.Delivery{At: now, Channel: c.Name, SiteID: ev.SiteID, Level: ev.Level}

	if c.Name == ChannelInApp {
		// 站内推送就是 SSE 广播，由 service 在预警变更时已经发出去了；
		// 这里只记一条"已送达"，让系统页能证明通道是活的。
		d.OK = true
		d.Detail = fmt.Sprintf("站内弹窗已广播（%s）", action)
		_ = n.store.InsertDelivery(d)
		return
	}

	if c.Name == ChannelWebhook {
		msg := fmt.Sprintf("[%s] %s %s 预警：%s", levelCN(ev.Level), ev.SiteID, ev.SiteName, ev.Reason)
		body := fmt.Sprintf(
			`{"text":%q,"site_id":%q,"site_name":%q,"level":%q,"action":%q,"peak_value":%.3f,"duration_min":%d,"reason":%q}`,
			msg, ev.SiteID, ev.SiteName, ev.Level, action, ev.PeakValue, ev.DurationMin, ev.Reason)

		req, err := http.NewRequest(http.MethodPost, c.Endpoint, strings.NewReader(body))
		if err != nil {
			d.Detail = "构造请求失败：" + err.Error()
			_ = n.store.InsertDelivery(d)
			return
		}
		req.Header.Set("Content-Type", "application/json")
		if c.Secret != "" {
			req.Header.Set("X-Waterlog-Secret", c.Secret)
		}
		resp, err := n.http.Do(req)
		if err != nil {
			d.Detail = "请求失败：" + err.Error()
			n.log.Warn("webhook 推送失败", "site", ev.SiteID, "err", err)
			_ = n.store.InsertDelivery(d)
			return
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		d.OK = resp.StatusCode < 400
		d.Detail = fmt.Sprintf("HTTP %d", resp.StatusCode)
		_ = n.store.InsertDelivery(d)
		return
	}

	// 未实现的渠道：明确记一条失败，而不是假装成功。
	d.Detail = "该渠道尚未接入（仅登记配置）"
	_ = n.store.InsertDelivery(d)
}

// Test 向指定渠道发一条测试消息，返回是否成功与说明。
func (n *Notifier) Test(name string, now int64) (bool, string, error) {
	c, err := n.store.NotifyChannel(name)
	if err != nil {
		return false, "", notFound("未知渠道：%s", name)
	}
	probe := &domain.WarningEvent{
		SiteID: "S00", SiteName: "测试站点", Level: "orange",
		Reason: "这是一条来自系统页的测试推送", PeakValue: 0.35, DurationMin: 45,
	}
	d := domain.Delivery{At: now, Channel: name, SiteID: probe.SiteID, Level: probe.Level}
	if !c.Enabled {
		d.Detail = "渠道未启用，仅记录一次测试尝试"
		_ = n.store.InsertDelivery(d)
		return false, d.Detail, nil
	}
	n.deliver(*c, probe, "test", now)
	rows, _ := n.store.Deliveries(1)
	if len(rows) > 0 {
		return rows[0].OK, rows[0].Detail, nil
	}
	return false, "未产生推送记录", nil
}

func maskSecret(s string) string {
	if s == "" {
		return ""
	}
	if len(s) <= 4 {
		return "****"
	}
	return s[:2] + "****" + s[len(s)-2:]
}

func validLevelOrEmpty(s string) bool {
	switch s {
	case "", "blue", "yellow", "orange", "red":
		return true
	}
	return false
}

func levelCN(level string) string {
	switch level {
	case "red":
		return "红色"
	case "orange":
		return "橙色"
	case "yellow":
		return "黄色"
	case "blue":
		return "蓝色"
	}
	return "无"
}
