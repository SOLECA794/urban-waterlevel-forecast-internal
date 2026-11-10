package icm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"waterlog-v3/api/internal/domain"
)

// ---------------------------------------------------------------- DataSource 抽象
//
// 项目契约要求「两个核心抽象」之一：DataSource（真实/模拟可切换）。
// 这里只定义**出站复用**这一侧的抽象，不触碰 v3 引擎侧的仿真源：
//   - ICMSource 真实现：调 R1/R2 取对方监测数据
//   - 仿真/离线源留在 v3 引擎侧，本包不重建
//
// EXT-POINT(DATASOURCE): 真实气象/降水预报源、视频/图像样本源尚未接入；
// 它们各自实现本接口即可插入链路，无需改动 MapRealtime 与 Sink。
type DataSource interface {
	// Name 用于日志与报告标注数据来源
	Name() string
	// Fetch 拉取原始监测记录
	Fetch(ctx context.Context) ([]MonitorRecord, error)
}

// ICMSource 是按对方接口复用取数的真实现。
type ICMSource struct {
	client     *Client
	deviceType string
	indexCodes []string
	history    bool
	beginTime  string
	endTime    string
}

// NewRealtimeSource 构造实时数据源（R1）。
func NewRealtimeSource(c *Client, deviceType string, indexCodes []string) *ICMSource {
	return &ICMSource{client: c, deviceType: deviceType, indexCodes: indexCodes}
}

// NewHistorySource 构造历史数据源（R2）。时间字符串用 FormatICMTime 生成。
func NewHistorySource(c *Client, deviceType string, indexCodes []string, beginTime, endTime string) *ICMSource {
	return &ICMSource{
		client: c, deviceType: deviceType, indexCodes: indexCodes,
		history: true, beginTime: beginTime, endTime: endTime,
	}
}

func (s *ICMSource) Name() string {
	if s.history {
		return "icm:R2/history"
	}
	return "icm:R1/realtime"
}

func (s *ICMSource) Fetch(ctx context.Context) ([]MonitorRecord, error) {
	dt := s.deviceType
	if dt == "" {
		dt = s.client.Config().DeviceType
	}
	q := MonitorDataQuery{
		DeviceType: dt,
		IndexCodes: s.indexCodes,
		IsDesc:     true,
	}
	if s.history {
		q.BeginTime, q.EndTime = s.beginTime, s.endTime
		return s.client.QueryHistoryData(ctx, q)
	}
	return s.client.QueryRealtimeData(ctx, q)
}

// ---------------------------------------------------------------- Sink：接入已有 ingest 入口
//
// 【事实】v3 已有 POST /api/ingest/telemetry（httpapi/ingest.go），
// 受 X-Ingest-Token 保护，接受 domain.TelemetryBatch，落库并推进预警四态、
// 广播 SSE。openapi.yaml 亦注明「外部真实数据源接入时改成往这里推即可，
// 其余全部链路不用改」。
//
// 【设计】本批**不新增任何路由、不改任何 handler**：Sink 只是这个已有
// 端点的 HTTP 客户端。默认 dry-run，不写库；调用方显式打开才写。
type Sink interface {
	Push(ctx context.Context, batch domain.TelemetryBatch) error
}

// IngestSink 把映射后的批次推给 v3 已有的 ingest 端点。
type IngestSink struct {
	url    string
	token  string
	client *http.Client
}

// NewIngestSink 构造写入端。cfg.IngestURL / cfg.IngestToken 均来自配置外置。
func NewIngestSink(cfg Config) *IngestSink {
	cfg = cfg.normalize()
	return &IngestSink{
		url:    cfg.IngestURL,
		token:  cfg.IngestToken,
		client: &http.Client{Timeout: cfg.Timeout},
	}
}

// Push 写入一批遥测。v3 成功返回 {"ok":true,"n":N}；
// 这里按约定**不凭 HTTP 200 判成功**，还要校验 ok 字段。
func (s *IngestSink) Push(ctx context.Context, batch domain.TelemetryBatch) error {
	body, err := json.Marshal(batch)
	if err != nil {
		return fmt.Errorf("marshal TelemetryBatch: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build ingest request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if s.token != "" {
		req.Header.Set("X-Ingest-Token", s.token)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("POST %s: %w", s.url, err)
	}
	defer resp.Body.Close()

	var out struct {
		OK    bool   `json:"ok"`
		N     int    `json:"n"`
		Error string `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !out.OK {
		return fmt.Errorf("ingest 未确认成功: http=%d ok=%v n=%d err=%q", resp.StatusCode, out.OK, out.N, out.Error)
	}
	return nil
}

// DryRunSink 是本批默认实现：只报告将要写入的行数，绝不写库。
// 符合契约（实现 Sink、返回符合契约的结果），避免"占位=缺失"。
type DryRunSink struct {
	Rows int
}

func (s *DryRunSink) Push(_ context.Context, batch domain.TelemetryBatch) error {
	s.Rows += len(batch.Rows)
	return nil
}

// ---------------------------------------------------------------- 一次同步

// SyncReport 是一次「拉取 → 映射 → 写入」的完整可诊断结果。
type SyncReport struct {
	Source     string    `json:"source"`
	IngestURL  string    `json:"ingestUrl"`
	DryRun     bool      `json:"dryRun"`
	Map        MapReport `json:"map"`
	PushedRows int       `json:"pushedRows"`
	WouldPush  int       `json:"wouldPush"`
	Warnings   []string  `json:"warnings,omitempty"`
}

// SyncOnce 串起本批的完整链路：DataSource.Fetch → MapRealtime → Sink.Push。
//
// 这是**独立单元**：不挂进 v3 主进程、不启 goroutine、不改路由。
// 由 cmd/icm-pull 手动或外部调度触发，未配置 WL_ICM_BASE_URL 时直接返回错误，
// 确保缺省状态下 v3 行为与改造前完全一致。
func SyncOnce(ctx context.Context, src DataSource, cfg Config, points PointMap, mc MapConfig, sink Sink) (SyncReport, error) {
	rep := SyncReport{
		Source:    src.Name(),
		IngestURL: cfg.normalize().IngestURL,
	}
	if err := ValidateMapConfig(cfg, mc); err != nil {
		return rep, err
	}
	records, err := src.Fetch(ctx)
	if err != nil {
		return rep, fmt.Errorf("%s 取数失败: %w", src.Name(), err)
	}
	batch, mr := MapRealtime(records, cfg, points, mc)
	rep.Map = mr
	rep.WouldPush = len(batch.Rows)

	if _, ok := sink.(*DryRunSink); ok {
		rep.DryRun = true
		rep.Warnings = append(rep.Warnings, mr.Warnings...)
		rep.Warnings = append(rep.Warnings,
			"dry-run：未写入 v3。确认时间基准与编码映射后，用 --push 显式开启写入。")
		_ = sink.Push(ctx, batch)
		return rep, nil
	}
	if err := sink.Push(ctx, batch); err != nil {
		return rep, fmt.Errorf("写入 ingest 失败: %w", err)
	}
	rep.PushedRows = len(batch.Rows)
	rep.Warnings = append(rep.Warnings, mr.Warnings...)
	rep.Warnings = append(rep.Warnings,
		"已写入 v3 ingest；若 v3 仍为 60x 仿真时钟，须确认 timeBasis=simulated 且 SimNow 已对齐。")
	return rep, nil
}
