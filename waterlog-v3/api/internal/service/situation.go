// Package service 承载业务编排：聚合视图、遥测/预测入库与预警推进、
// 处置闭环、引擎 HTTP 客户端。
//
// 这一层不碰 net/http 的 Request/ResponseWriter（除了引擎客户端自己发请求），
// 所以 handler 只做"解析参数 → 调 service → 写 JSON"。
package service

import (
	"context"
	"sort"
	"sync"
	"time"

	"waterlog-v3/api/internal/domain"
	"waterlog-v3/api/internal/store"
)

// Service 聚合所有业务依赖。Go 侧不做任何计算，只做：接收 → 存储 → 分发。
// 唯一的例外是预警事件的四态同步（SyncWarning），因为它是"事件"不是"数值"，
// 必须在一个事务里判定迁移是否合法，放 Python 侧反而会拆成两处状态。
type Service struct {
	store  *store.Store
	engine *Engine
	hub    *Hub

	mu       sync.RWMutex
	forecast *domain.ForecastPayload

	sites   []domain.SiteMeta
	siteMap map[string]domain.SiteMeta

	// notifier 由 main 注入，而不是在 New 里构造：
	// 它需要一个 logger，而 service 层刻意不持有 logger。
	notifier *Notifier
}

// SetNotifier 注入推送器。未注入时预警照常升起，只是不往外推。
func (s *Service) SetNotifier(n *Notifier) { s.notifier = n }

// New 构造业务服务。站点清单需要随后调用 LoadSites 载入。
func New(st *store.Store, engine *Engine, hub *Hub) *Service {
	return &Service{
		store:   st,
		engine:  engine,
		hub:     hub,
		siteMap: map[string]domain.SiteMeta{},
	}
}

// LoadSites 载入站点清单。
//
// 站点清单在 Python config.py 里是唯一事实来源。这里在启动时从引擎拉一次，
// 拉不到就用内置副本——保证 Go 单独起也能跑（比如只调前端样式的时候）。
func (s *Service) LoadSites(ctx context.Context) {
	sites, err := s.engine.FetchSites(ctx)
	if err != nil || len(sites) == 0 {
		sites = BuiltinSites()
	}
	s.sites = sites
	s.siteMap = make(map[string]domain.SiteMeta, len(sites))
	for _, m := range sites {
		s.siteMap[m.SiteID] = m
	}
}

// RestoreForecast 启动时把已有快照读回来，避免前端刷新看到空白。
func (s *Service) RestoreForecast() {
	if p, err := s.store.LatestForecast(); err == nil && p != nil {
		s.SetForecast(p)
	}
}

// StartPrune 起一个后台协程定期清理过期数据（阻塞到 ctx 结束）。
func (s *Service) StartPrune(ctx context.Context, keepHours int, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.store.Prune(keepHours)
		}
	}
}

// SetForecast 更新内存里的最新预测快照。
func (s *Service) SetForecast(p *domain.ForecastPayload) {
	s.mu.Lock()
	s.forecast = p
	s.mu.Unlock()
}

// Forecast 取内存里的最新预测快照（可能为 nil）。
func (s *Service) Forecast() *domain.ForecastPayload {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.forecast
}

// Sites 返回站点清单（顺序与载入时一致）。
func (s *Service) Sites() []domain.SiteMeta { return s.sites }

// Site 按 ID 取站点元数据。
func (s *Service) Site(id string) (domain.SiteMeta, bool) {
	m, ok := s.siteMap[id]
	return m, ok
}

// SiteName 返回站点中文名；未知站点返回空串（与既有行为一致）。
func (s *Service) SiteName(id string) string {
	if m, ok := s.siteMap[id]; ok {
		return m.Name
	}
	return ""
}

// Hub 暴露广播中心（SSE 端点需要直接订阅）。
func (s *Service) Hub() *Hub { return s.hub }

// NowTS 暴露遥测时钟，供 handler 做窗口查询基准。
func (s *Service) NowTS() int64 { return s.store.NowTS() }

// ---------------------------------------------------------------- 一张图

// Overview 是"一张图"的数据源：站点按预警等级着色，需要一次性拿到全部状态。
func (s *Service) Overview() ([]domain.OverviewSite, int64, error) {
	latest, err := s.store.Latest()
	if err != nil {
		return nil, 0, err
	}
	fc := s.Forecast()
	now := s.store.NowTS()

	out := make([]domain.OverviewSite, 0, len(s.sites))
	for _, m := range s.sites {
		row := domain.OverviewSite{
			SiteID: m.SiteID, Name: m.Name, District: m.District, Lon: m.Lon, Lat: m.Lat,
			BaseLevel: m.BaseLevel, Thresholds: m.Thresholds, Kind: m.Kind,
			WarnLevel: "none",
		}
		if t, ok := latest[m.SiteID]; ok {
			row.Level, row.Rain, row.Quality, row.UpdatedAt = t.Level, t.Rain, t.Quality, t.TS
			row.Depth = t.Level - m.BaseLevel
			row.Trend1h = s.store.Trend(m.SiteID, 60, now)
		}
		if fc != nil {
			if sf, ok := fc.Sites[m.SiteID]; ok {
				row.WarnLevel = sf.Warning.Level
				row.WarnScore = sf.Warning.Score
				row.PeakValue = sf.Warning.PeakValue
				row.PeakAtMin = sf.Warning.PeakAtMin
				row.Duration = sf.Warning.DurationMin
				row.SlopeMH = sf.Warning.SlopeMH
				row.Reason = sf.Warning.Reason
				row.Factors = sf.Warning.Factors
				row.PeakLevel = sf.Warning.PeakLevel
				row.HorizonMin = sf.Warning.HorizonMin
			}
		}
		// 最近 3h 火花线（20 个点，压缩成等间隔）
		if series, err := s.store.Series(m.SiteID, now-3*3600); err == nil && len(series) > 0 {
			step := len(series) / 20
			if step < 1 {
				step = 1
			}
			for i := 0; i < len(series); i += step {
				row.Spark = append(row.Spark, series[i].Level)
			}
			if len(row.Spark) > 20 {
				row.Spark = row.Spark[:20]
			}
		}
		out = append(out, row)
	}
	// 按预警等级降序、再按评分降序——值班员第一眼看到最急的
	sort.SliceStable(out, func(i, j int) bool {
		ri, rj := domain.LevelRankOf(out[i].WarnLevel), domain.LevelRankOf(out[j].WarnLevel)
		if ri != rj {
			return ri > rj
		}
		return out[i].WarnScore > out[j].WarnScore
	})
	return out, now, nil
}

// ---------------------------------------------------------------- 站点详情 / 历史

// SiteDetail 汇总单个站点的静态信息、最近 24h 曲线、最新实测与预测。
func (s *Service) SiteDetail(id string) (map[string]any, bool, error) {
	meta, ok := s.Site(id)
	if !ok {
		return nil, false, nil
	}
	fc := s.Forecast()
	latest, _ := s.store.Latest()

	hist, _ := s.store.Series(id, s.store.NowTS()-24*3600)
	out := map[string]any{"site": meta, "history": hist}
	if t, ok := latest[id]; ok {
		out["latest"] = t
	}
	if fc != nil {
		if sf, ok := fc.Sites[id]; ok {
			out["forecast"] = sf
			out["issued_at"] = fc.IssuedAt
			out["model_version"] = fc.ModelVersion
		}
	}
	return out, true, nil
}

// SiteHistory 返回某站点最近 hours 小时的曲线点。
func (s *Service) SiteHistory(id string, hours int) ([]domain.SeriesPoint, error) {
	return s.store.Series(id, s.store.NowTS()-int64(hours*3600))
}

// SeriesAll 返回所有站在最近 hours 小时内的历史序列，按站点分组。
func (s *Service) SeriesAll(hours int) (map[string][]domain.SeriesPoint, error) {
	return s.store.SeriesAll(s.store.NowTS() - int64(hours*3600))
}

// ---------------------------------------------------------------- 预警读取

// ListAlerts 列出预警事件，并补齐站点中文名。
func (s *Service) ListAlerts(activeOnly bool, limit int) ([]domain.WarningEvent, error) {
	evs, err := s.store.Warnings(activeOnly, limit)
	if err != nil {
		return nil, err
	}
	for i := range evs {
		if m, ok := s.siteMap[evs[i].SiteID]; ok {
			evs[i].SiteName = m.Name
		}
	}
	return evs, nil
}

// AlertDetail 返回单条预警及其处置记录。
func (s *Service) AlertDetail(id int64) (*domain.WarningEvent, []domain.AlertNote, error) {
	ev, err := s.store.WarningByID(id)
	if err != nil {
		return nil, nil, err
	}
	if m, ok := s.siteMap[ev.SiteID]; ok {
		ev.SiteName = m.Name
	}
	notes, err := s.store.AlertNotes(id)
	if err != nil {
		return nil, nil, err
	}
	return ev, notes, nil
}
