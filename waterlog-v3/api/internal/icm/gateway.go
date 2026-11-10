package icm

// Gateway 是「② 集成适配网关」的执行体。
//
// 与第一批代码的分工：
//   - client / endpoints / map / source 负责「一次」拉取怎么调、字段怎么映射
//     （见 SyncOnce：拉取 → 映射 → 写入）。
//   - 本文件负责「一直」拉下去：周期调度、失败退避、健康度对外可见。
//
// 为什么不让网关直接改 v3 主干：协议差异归一化是**接入层**的事，
// 把它塞进 service/store 会让「ICM 侧的口径」渗进 v3 的领域模型。
// 网关只做三件事——调 ICM、把结果写进已有的 ingest 端、把健康度报出来。
//
// EXT-POINT(INTEGRATION): 熔断器、限流、失败告警上报尚未实现。
// 当前策略是「失败退避 + 连续失败计数」：连续失败越多，下一轮间隔越长，
// 避免对方接口异常时把自己打成 DDoS 源。真正的熔断需要对方给出错误码语义
// （哪些 code 属于「对方故障」、哪些属于「我方参数错」），见 docs/06 §8 Q6。

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"
)

// 默认调度间隔。10 分钟一次对「内涝监测」这类分钟级数据偏粗，
// 但真实拉取频率要跟对方系统的写入频率与我们的存储压力一起定，
// 在没有真实环境数据前取一个保守值。
const defaultGatewayInterval = 5 * time.Minute

// backoffBase 是连续失败时的额外退避基数。
const backoffBase = 30 * time.Second

// backoffMax 封顶，避免连续失败把间隔拉到几十分钟。
const backoffMax = 10 * time.Minute

// GatewayOptions 是网关的可选参数。
type GatewayOptions struct {
	// Interval 两次同步之间的基准间隔。<=0 时取默认 5 分钟。
	Interval time.Duration
	// Logger 日志回调；nil 时不记日志。
	Logger func(format string, args ...any)
	// Now 取当前时间；nil 时用 time.Now。测试可注入固定时钟。
	Now func() time.Time
}

// HealthStatus 是网关的对外健康快照。
//
// 它回答的是「现在还能不能拿到数据」，而不是「一切正常吗」——
// 一个网关连续失败 3 次是**降级**而不是**故障**，业务侧要能区分。
type HealthStatus struct {
	// Enabled 是否配置了对方地址。未配置时网关不会发起任何调用。
	Enabled bool `json:"enabled"`
	// IntervalSec 当前生效的同步间隔（秒，含退避）。
	IntervalSec int `json:"intervalSec"`
	// TotalRuns 累计执行次数。
	TotalRuns int64 `json:"totalRuns"`
	// TotalFailures 累计失败次数。
	TotalFailures int64 `json:"totalFailures"`
	// ConsecutiveFails 当前连续失败次数，成功一次即归零。
	ConsecutiveFails int `json:"consecutiveFails"`
	// Degraded 是否处于降级状态（连续失败 ≥ 1）。
	Degraded bool `json:"degraded"`
	// LastRunAt 最近一次执行时刻（Unix 秒）。
	LastRunAt int64 `json:"lastRunAt"`
	// LastSuccessAt 最近一次成功时刻（Unix 秒）；从未成功为 0。
	LastSuccessAt int64 `json:"lastSuccessAt"`
	// LastError 最近一次失败原因。
	//
	// 注意：成功之后**不清空**。它回答的是「上一次为什么失败」，
	// 而不是「现在有没有错」——后者由 Degraded / ConsecutiveFails 回答。
	// 运维排障时最需要的信息恰恰是「刚才失败过，原因是 X」。
	LastError string `json:"lastError"`
	// LastRows 最近一次成功写入的行数。
	LastRows int `json:"lastRows"`
	// LastReport 最近一次执行的完整报告。
	LastReport *SyncReport `json:"lastReport,omitempty"`
}

// Gateway 把一次性的拉取能力变成持续运行的数据供给。
type Gateway struct {
	cfg    Config
	src    DataSource
	sink   Sink
	points PointMap
	mc     MapConfig
	opts   GatewayOptions

	mu     sync.RWMutex
	health HealthStatus
}

// NewGateway 构造网关。
//
// src / sink / points / mc 的语义与 SyncOnce 完全一致，网关只是把 SyncOnce
// 放进一个循环里——这样「手动拉一次」和「一直拉」走的是同一条代码路径，
// 不会出现只有定时任务能跑通、手动调不通的情况。
func NewGateway(
	cfg Config,
	src DataSource,
	sink Sink,
	points PointMap,
	mc MapConfig,
	opts GatewayOptions,
) *Gateway {
	if opts.Interval <= 0 {
		opts.Interval = defaultGatewayInterval
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Gateway{
		cfg:    cfg,
		src:    src,
		sink:   sink,
		points: points,
		mc:     mc,
		opts:   opts,
		health: HealthStatus{
			Enabled:     cfg.Enabled(),
			IntervalSec: int(opts.Interval / time.Second),
		},
	}
}

// logf 记日志；未配置回调时静默。
func (g *Gateway) logf(format string, args ...any) {
	if g.opts.Logger != nil {
		g.opts.Logger(format, args...)
	}
}

// Health 返回当前健康快照（副本，调用方拿到后不受后续并发写入影响）。
func (g *Gateway) Health() HealthStatus {
	g.mu.RLock()
	defer g.mu.RUnlock()
	h := g.health
	if g.health.LastReport != nil {
		rep := *g.health.LastReport
		// 告警切片也要拷：只拷结构体的话切片底层数组还是共享的，
		// 调用方改一个元素就会污染网关内部留存的报告。
		rep.Warnings = append([]string(nil), g.health.LastReport.Warnings...)
		rep.Map.Warnings = append([]string(nil), g.health.LastReport.Map.Warnings...)
		h.LastReport = &rep
	}
	return h
}

// SyncOnce 执行一轮同步并更新健康状态。
//
// 它是公开的，方便运维用「手动拉一次」验证网关配置是否正确
// （例如确认监测项编码、点位映射对不对），而不必等一个调度周期。
func (g *Gateway) SyncOnce(ctx context.Context) (SyncReport, error) {
	rep, err := SyncOnce(ctx, g.src, g.cfg, g.points, g.mc, g.sink)
	now := g.opts.Now().Unix()

	g.mu.Lock()
	g.health.TotalRuns++
	g.health.LastRunAt = now
	g.health.LastReport = &rep
	if err != nil {
		g.health.TotalFailures++
		g.health.ConsecutiveFails++
		g.health.Degraded = true
		g.health.LastError = err.Error()
	} else {
		g.health.ConsecutiveFails = 0
		g.health.Degraded = false
		g.health.LastSuccessAt = now
		g.health.LastRows = rep.PushedRows
		// 刻意不清空 LastError：它回答的是「上一次为什么失败」，
		// 现在有没有错由 Degraded / ConsecutiveFails 回答。
		// 运维排障时最需要的恰恰是「刚才失败过，原因是 X」。
	}
	g.mu.Unlock()

	if err != nil {
		g.logf("[icm] 同步失败：%v", err)
	} else {
		g.logf("[icm] 同步完成：写入 %d 行（映射告警 %d 条）", rep.PushedRows, len(rep.Map.Warnings))
	}
	return rep, err
}

// Run 启动周期同步，直到 ctx 被取消。
//
// 退避规则：连续失败时，下一轮的间隔 = 基准间隔 + 递增退避（30s、60s、120s…，
// 封顶 10 分钟）；一旦成功立即归零。间隔变了 Health().IntervalSec 会同步反映，
// 便于运维从健康端点看出「当前正处于退避状态」。
//
// 注意：Run 会阻塞，调用方应放在 goroutine 里，并保证 ctx 能被取消。
func (g *Gateway) Run(ctx context.Context) {
	if !g.cfg.Enabled() {
		g.logf("[icm] 未配置 WL_ICM_BASE_URL，网关不启用")
		return
	}
	g.logf("[icm] 网关启动：间隔 %s", g.opts.Interval)

	timer := time.NewTimer(0) // 立即先跑一轮，不等一个完整周期
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			g.logf("[icm] 网关停止")
			return
		case <-timer.C:
			_, err := g.SyncOnce(ctx)
			delay := g.nextDelay(err)
			g.mu.Lock()
			g.health.IntervalSec = int(delay / time.Second)
			g.mu.Unlock()
			timer.Reset(delay)
		}
	}
}

// nextDelay 计算下一轮的等待时长：失败越多等得越久。
//
// 封顶作用在**总间隔**上（而不是退避增量上）：否则基准 5 分钟 + 退避 10 分钟
// 会让人等 15 分钟才重试一次，比运维预期的上限还长，健康端点里的
// intervalSec 也会失真。
//
// 例外：基准间隔本身就长于封顶时以基准为准——否则失败反而比重试成功更频繁，
// 与退避的目的正好相反。
func (g *Gateway) nextDelay(err error) time.Duration {
	base := g.opts.Interval
	if err == nil {
		return base
	}
	g.mu.RLock()
	fails := g.health.ConsecutiveFails
	g.mu.RUnlock()
	if fails <= 0 {
		return base
	}
	backoff := backoffBase
	for i := 1; i < fails && backoff < backoffMax; i++ {
		backoff *= 2
	}
	if backoff > backoffMax {
		backoff = backoffMax
	}
	cap := backoffMax
	if base > cap {
		cap = base
	}
	total := base + backoff
	if total > cap {
		total = cap
	}
	return total
}

// ---------------------------------------------------------------- 环境装配

// GatewayParts 是装配一个网关所需的全部部件。
//
// 为什么不直接返回一串值：部件有六七个，一串返回值很容易在调用点搞错顺序，
// 而顺序错了（比如把 sink 传成 src）编译器不会报错，只会在运行时空指针。
type GatewayParts struct {
	// Config 对方连接与写入配置（已 normalize）。
	Config Config
	// Client 出站客户端。暴露出来是为了让调用方挂日志：
	// 网关只报「同步失败」，看不到具体是哪个请求、哪个 code 失败的。
	Client *Client
	// Src 取数侧。
	Src DataSource
	// Sink 写入侧。默认 DryRunSink（只报告不写库），显式开启才写。
	Sink Sink
	// Points 编码对照表。
	Points PointMap
	// Map 字段与时间基准映射。
	Map MapConfig
	// Interval 同步周期。
	Interval time.Duration
	// DryRun 是否处于只报告不写库的状态（供启动日志与健康端点说明）。
	DryRun bool
}

// GatewayConfigFromEnv 从环境变量装配网关所需的部件。
//
// 返回 ok=false 表示「网关不启用」，**不是错误**：网关是可选能力，
// 未配置 WL_ICM_BASE_URL 时 v3 的行为必须与改造前完全一致，
// 不该因为「没配对方地址」就起不来。
//
// err 非 nil 表示「配了但配错了」（如 timeBasis 非法、simulated 基准拿不到仿真时钟）。
// 这种情况下调用方应当记一条错误日志并跳过网关，同样不该拖垮整个进程。
//
// simNow 是 v3 当前的仿真时钟（Unix 秒）。用注入而不是让本包自己去找：
// icm 是接入层，反向依赖 service/store 会把包依赖搞成环，
// 也违背「不改 v3 主干」的边界。调用方从 svc.NowTS() 取了传进来。
//
// 环境变量：
//
//	WL_ICM_INDEX_CODES  逗号分隔的设备编码；空 = 拉全部设备
//	WL_ICM_PUSH         =1 时才写入 v3（默认只 dry-run 报告）
//	WL_ICM_TIME_BASIS   real / simulated，默认 real
//	WL_ICM_INTERVAL_SEC 同步周期（秒），默认 5 分钟
func GatewayConfigFromEnv(simNow func() int64) (GatewayParts, bool, error) {
	cfg := Load()
	if !cfg.Enabled() {
		return GatewayParts{}, false, nil
	}

	points := ParsePointMap(envStr("WL_ICM_POINT_MAP", ""))
	mc := MapConfig{
		LevelItem: cfg.MonitorItem,
		RainItem:  cfg.MonitorItemRain,
		Basis:     TimeBasis(envStr("WL_ICM_TIME_BASIS", string(TimeBasisReal))),
	}
	if mc.Basis == TimeBasisSimulated {
		// 仿真基准下必须有仿真时钟，否则写进去的时间戳全是 0，
		// 那批数据在 v3 里没法用。与其写坏数据，不如不启用。
		if simNow == nil {
			return GatewayParts{}, false, errors.New("timeBasis=simulated 需要调用方提供 v3 仿真时钟")
		}
		mc.SimNow = simNow
	}
	if err := ValidateMapConfig(cfg, mc); err != nil {
		return GatewayParts{}, false, err
	}

	client := NewClient(cfg)
	src := NewRealtimeSource(client, cfg.DeviceType, ParseIndexCodes(envStr("WL_ICM_INDEX_CODES", "")))

	// 默认 dry-run：对方接口刚接上、编码映射还没核对过，
	// 这时候写库只会把错数据灌进 v3。要写必须显式开 WL_ICM_PUSH=1。
	sink := Sink(&DryRunSink{})
	dryRun := true
	if pushEnabled(envStr("WL_ICM_PUSH", "")) {
		sink = NewIngestSink(cfg)
		dryRun = false
	}

	return GatewayParts{
		Config:   cfg,
		Client:   client,
		Src:      src,
		Sink:     sink,
		Points:   points,
		Map:      mc,
		Interval: gatewayIntervalFromEnv(),
		DryRun:   dryRun,
	}, true, nil
}

// ParseIndexCodes 解析逗号分隔的设备编码；空串返回 nil（= 拉全部设备）。
func ParseIndexCodes(s string) []string {
	var out []string
	for _, c := range strings.Split(s, ",") {
		if c = strings.TrimSpace(c); c != "" {
			out = append(out, c)
		}
	}
	return out
}

// pushEnabled 判断是否显式开启写入。只认 1 / true / yes，
// 避免「随手写了个 WL_ICM_PUSH=0」这种被当成真值。
func pushEnabled(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes":
		return true
	}
	return false
}

// gatewayIntervalFromEnv 读同步周期（秒）。非正数回落默认——
// 周期为 0 会变成忙循环，把对方接口打成 DDoS 源。
func gatewayIntervalFromEnv() time.Duration {
	sec := envInt("WL_ICM_INTERVAL_SEC", int(defaultGatewayInterval/time.Second))
	if sec <= 0 {
		sec = int(defaultGatewayInterval / time.Second)
	}
	return time.Duration(sec) * time.Second
}
