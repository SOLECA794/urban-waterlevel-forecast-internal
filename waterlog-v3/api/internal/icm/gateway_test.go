package icm

// 网关的测试：退避、健康状态机、全链路 dry-run、健康快照的隔离性。
//
// 与 icm_test.go 的分工：那边测「一次调用怎么打通协议」，这边测
// 「一直调下去会不会越来越糟」——退避会不会失控、健康快照会不会骗人。
//
// 同样注意：本测试没有与真实 ICM 平台联调（无地址/凭据），
// 只验证本地链路与状态机正确性。

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ---------------------------------------------------------------- 测试替身

// stubSource 是可控取数源：要么给记录，要么给错误。
//
// err 用互斥锁保护：测试会在「成功」与「失败」之间切换取数源的行为，
// 而网关读它可能发生在另一个 goroutine 上，不能靠测试里的执行顺序碰运气。
type stubSource struct {
	name string
	recs []MonitorRecord

	mu  sync.RWMutex
	err error
}

func (s *stubSource) Name() string { return s.name }

func (s *stubSource) Fetch(context.Context) ([]MonitorRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.err != nil {
		return nil, s.err
	}
	return s.recs, nil
}

// setErr 切换取数源的行为。
func (s *stubSource) setErr(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.err = err
}

// fakeICM 起一个假的 ICM 平台，只实现 R1 实时监测数据接口。
func fakeICM(t *testing.T, rows string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != PathRealtimeData {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		writeEnv(w, `"0"`, `{"total":1,"pageNo":"1","pageSize":"2","list":[`+rows+`]}`)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func record(indexCode, ts, level string) MonitorRecord {
	return MonitorRecord{
		ID:          "id-" + indexCode,
		IndexCode:   indexCode,
		MonitorTime: ts,
		Raw:         map[string]json.RawMessage{"wl": json.RawMessage(level)},
	}
}

// ---------------------------------------------------------------- 退避

// TestNextDelayBackoff：失败越多等得越久，成功一次立刻回到基准间隔，
// 并且任何情况下都不超过 backoffMax。
func TestNextDelayBackoff(t *testing.T) {
	g := NewGateway(
		testConfig("http://unused"),
		&stubSource{name: "stub"},
		&DryRunSink{},
		IdentityPointMap{},
		MapConfig{},
		GatewayOptions{Interval: 5 * time.Minute},
	)

	cases := []struct {
		name  string
		fails int
		err   error
	}{
		{"成功回到基准间隔", 0, nil},
		{"失败一次开始退避", 1, errors.New("boom")},
		{"连续失败两次", 2, errors.New("boom")},
		{"连续失败三次", 3, errors.New("boom")},
		{"连续失败很多次应封顶", 20, errors.New("boom")},
	}
	prev := time.Duration(0)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g.mu.Lock()
			g.health.ConsecutiveFails = tc.fails
			g.mu.Unlock()

			d := g.nextDelay(tc.err)
			if d > backoffMax {
				t.Fatalf("间隔 %s 超过封顶 %s", d, backoffMax)
			}
			if tc.err == nil {
				if d != g.opts.Interval {
					t.Fatalf("成功后应回到基准间隔 %s，实际 %s", g.opts.Interval, d)
				}
				return
			}
			if d <= g.opts.Interval {
				t.Fatalf("失败后间隔应长于基准 %s，实际 %s", g.opts.Interval, d)
			}
			if prev > 0 && d < prev {
				t.Fatalf("失败次数变多间隔却变短：%s → %s", prev, d)
			}
			prev = d
		})
	}
}

// TestNextDelayResetsAfterSuccess：连续失败把间隔拉长后，
// 成功一次必须把退避清零，否则一次偶发成功会把间隔留在高位。
func TestNextDelayResetsAfterSuccess(t *testing.T) {
	g := NewGateway(
		testConfig("http://unused"),
		&stubSource{name: "stub"},
		&DryRunSink{},
		IdentityPointMap{},
		MapConfig{},
		GatewayOptions{Interval: time.Minute},
	)
	g.mu.Lock()
	g.health.ConsecutiveFails = 5
	g.mu.Unlock()
	backed := g.nextDelay(errors.New("boom"))

	g.mu.Lock()
	g.health.ConsecutiveFails = 0
	g.mu.Unlock()
	after := g.nextDelay(nil)

	if after != time.Minute {
		t.Fatalf("成功后应回到基准间隔，实际 %s", after)
	}
	if after >= backed {
		t.Fatalf("成功后的间隔 %s 应短于退避后的 %s", after, backed)
	}
}

// ---------------------------------------------------------------- 健康状态机

// TestHealthStateTransitions：成功与失败对健康快照的影响必须符合语义，
// 尤其是「降级」与「连续失败」要能互相印证。
func TestHealthStateTransitions(t *testing.T) {
	fixed := time.Unix(1_700_000_000, 0)
	src := &stubSource{name: "stub"}
	g := NewGateway(
		testConfig("http://unused"),
		src,
		&DryRunSink{},
		IdentityPointMap{},
		MapConfig{},
		GatewayOptions{Interval: time.Minute, Now: func() time.Time { return fixed }},
	)

	// 第一次失败
	src.setErr(errors.New("对方 500"))
	if _, err := g.SyncOnce(context.Background()); err == nil {
		t.Fatal("取数失败应返回错误")
	}
	h := g.Health()
	if !h.Degraded {
		t.Fatal("失败后应处于降级状态")
	}
	if h.TotalFailures != 1 || h.ConsecutiveFails != 1 {
		t.Fatalf("失败计数不对: %+v", h)
	}
	if h.LastError == "" {
		t.Fatal("失败后应记录 lastError")
	}
	if h.LastSuccessAt != 0 {
		t.Fatalf("从未成功过 lastSuccessAt 应为 0，实际 %d", h.LastSuccessAt)
	}
	failedAt := h.LastError

	// 第二次失败：计数继续累加
	_, _ = g.SyncOnce(context.Background())
	h = g.Health()
	if h.TotalFailures != 2 || h.ConsecutiveFails != 2 {
		t.Fatalf("二次失败计数不对: %+v", h)
	}

	// 成功一次：降级解除、连续失败归零
	src.setErr(nil)
	if _, err := g.SyncOnce(context.Background()); err != nil {
		t.Fatalf("成功路径不应报错: %v", err)
	}
	h = g.Health()
	if h.Degraded {
		t.Fatal("成功后不应仍处于降级状态")
	}
	if h.ConsecutiveFails != 0 {
		t.Fatalf("成功后连续失败数应归零，实际 %d", h.ConsecutiveFails)
	}
	if h.LastSuccessAt != fixed.Unix() {
		t.Fatalf("lastSuccessAt 应更新为 %d，实际 %d", fixed.Unix(), h.LastSuccessAt)
	}
	if h.TotalFailures != 2 {
		t.Fatalf("累计失败数不应被成功清零，实际 %d", h.TotalFailures)
	}
	if h.LastRunAt != fixed.Unix() {
		t.Fatalf("lastRunAt 应更新，实际 %d", h.LastRunAt)
	}
	// lastError 刻意保留：它回答「上次为什么失败」，不回答「现在有没有错」
	if h.LastError != failedAt {
		t.Fatalf("lastError 应保留最近一次失败原因，实际 %q", h.LastError)
	}
}

// ---------------------------------------------------------------- 全链路 dry-run

// TestGatewaySyncOnceDryRun：走完「取数 → 映射 → 写入」全链路，
// dry-run 下不能有任何写入动作，但必须报告「本来会写多少行」。
func TestGatewaySyncOnceDryRun(t *testing.T) {
	srv := fakeICM(t, `{"id":"a","indexCode":"DEV1","monitorTime":"2024-07-05T00:00:00.000+08:00","wl":"1.25"}`)

	// ingest 端点也起一个假的：它一旦被调用就说明 dry-run 失效了。
	var ingestCalls atomic.Int32
	ingest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ingestCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"n":1}`))
	}))
	defer ingest.Close()

	cfg := testConfig(srv.URL)
	cfg.IngestURL = ingest.URL
	client := NewClient(cfg)
	src := NewRealtimeSource(client, cfg.DeviceType, nil)
	dry := &DryRunSink{}

	g := NewGateway(cfg, src, dry, ParsePointMap("DEV1=S01"), MapConfig{}, GatewayOptions{Interval: time.Minute})
	rep, err := g.SyncOnce(context.Background())
	if err != nil {
		t.Fatalf("同步失败: %v", err)
	}
	if rep.PushedRows != 0 {
		t.Fatalf("dry-run 不得写入，实际 pushedRows=%d", rep.PushedRows)
	}
	if rep.WouldPush <= 0 {
		t.Fatalf("dry-run 也应报告本会写入的行数，实际 %d", rep.WouldPush)
	}
	if !rep.DryRun {
		t.Fatal("报告应标记 dryRun=true")
	}
	if n := ingestCalls.Load(); n != 0 {
		t.Fatalf("dry-run 不得触碰 ingest 端点，实际调用 %d 次", n)
	}
	// DryRunSink 内部的 Rows 记的是「本应推送多少行」，
	// 真正的「有没有写库」由 PushedRows==0 与 ingest 端点零请求共同证明。
	if dry.Rows != rep.WouldPush {
		t.Fatalf("dry-run 计数应等于 wouldPush，实际 rows=%d wouldPush=%d", dry.Rows, rep.WouldPush)
	}
	h := g.Health()
	if h.Degraded || h.TotalRuns != 1 || h.TotalFailures != 0 {
		t.Fatalf("健康状态不对: %+v", h)
	}
	if h.LastReport == nil || h.LastReport.WouldPush != rep.WouldPush {
		t.Fatalf("健康快照应带最近一次报告: %+v", h.LastReport)
	}
}

// TestGatewaySyncOnceFailure：对方报错时必须记为降级，且不能把行数写成 0 之外的东西。
func TestGatewaySyncOnceFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		writeEnv(w, `"500"`, `null`)
	}))
	defer srv.Close()
	cfg := testConfig(srv.URL)
	client := NewClient(cfg)
	src := NewRealtimeSource(client, cfg.DeviceType, nil)

	g := NewGateway(cfg, src, &DryRunSink{}, IdentityPointMap{}, MapConfig{}, GatewayOptions{Interval: time.Minute})
	if _, err := g.SyncOnce(context.Background()); err == nil {
		t.Fatal("对方 500 应判失败")
	}
	h := g.Health()
	if !h.Degraded || h.TotalFailures != 1 || h.LastError == "" {
		t.Fatalf("失败后的健康状态不对: %+v", h)
	}
}

// ---------------------------------------------------------------- 快照隔离

// TestHealthReturnsCopy：拿到的快照必须与网关内部状态解耦，
// 否则调用方改一下快照就把网关的历史报告改脏了。
func TestHealthReturnsCopy(t *testing.T) {
	g := NewGateway(
		testConfig("http://unused"),
		&stubSource{name: "stub", recs: []MonitorRecord{record("DEV1", "2024-07-05T00:00:00.000+08:00", "1.25")}},
		&DryRunSink{},
		IdentityPointMap{},
		MapConfig{},
		GatewayOptions{Interval: time.Minute},
	)
	if _, err := g.SyncOnce(context.Background()); err != nil {
		t.Fatalf("同步失败: %v", err)
	}

	snap := g.Health()
	if snap.LastReport == nil {
		t.Fatal("快照应带最近一次报告")
	}
	before := snap.TotalRuns

	// 网关继续跑，快照不该跟着变
	if _, err := g.SyncOnce(context.Background()); err != nil {
		t.Fatalf("同步失败: %v", err)
	}
	if snap.TotalRuns != before {
		t.Fatalf("快照不应随网关变化：%d → %d", before, snap.TotalRuns)
	}

	// 反过来：调用方改快照，也不该污染网关内部留存
	innerBefore := g.Health()
	innerWarnBefore := len(innerBefore.LastReport.Warnings)
	innerMapWarnBefore := len(innerBefore.LastReport.Map.Warnings)

	snap.LastReport.Warnings = append(snap.LastReport.Warnings, "调用方乱加的告警")
	snap.LastReport.Map.Warnings = append(snap.LastReport.Map.Warnings, "调用方乱加的映射告警")

	inner := g.Health()
	if len(inner.LastReport.Warnings) != innerWarnBefore {
		t.Fatalf("调用方改动污染了网关内部报告: %+v", inner.LastReport.Warnings)
	}
	if len(inner.LastReport.Map.Warnings) != innerMapWarnBefore {
		t.Fatalf("调用方改动污染了网关内部映射告警: %+v", inner.LastReport.Map.Warnings)
	}
}

// TestHealthConcurrentAccess：健康快照可能被健康端点（HTTP goroutine）读，
// 同时被网关自己的调度 goroutine 写，必须并发安全。
func TestHealthConcurrentAccess(t *testing.T) {
	g := NewGateway(
		testConfig("http://unused"),
		&stubSource{name: "stub", recs: []MonitorRecord{record("DEV1", "2024-07-05T00:00:00.000+08:00", "1.25")}},
		&DryRunSink{},
		IdentityPointMap{},
		MapConfig{},
		GatewayOptions{Interval: time.Minute},
	)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 50; i++ {
			_, _ = g.SyncOnce(context.Background())
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 50; i++ {
			h := g.Health()
			if h.TotalRuns < 0 {
				t.Error("不应出现负数计数")
			}
		}
	}()
	wg.Wait()
}

// ---------------------------------------------------------------- 环境装配

// TestGatewayConfigFromEnvNotEnabled：没配对方地址时装配函数必须返回
// 「不启用」而不是错误——网关是可选能力，不能因为它没配就让服务起不来。
func TestGatewayConfigFromEnvNotEnabled(t *testing.T) {
	t.Setenv("WL_ICM_BASE_URL", "")
	t.Setenv("WL_ICM_TIME_BASIS", "")
	t.Setenv("WL_ICM_PUSH", "")
	t.Setenv("WL_ICM_INDEX_CODES", "")
	t.Setenv("WL_ICM_POINT_MAP", "")
	t.Setenv("WL_ICM_INTERVAL_SEC", "")

	parts, ok, err := GatewayConfigFromEnv(nil)
	if err != nil {
		t.Fatalf("未启用不应返回错误: %v", err)
	}
	if ok {
		t.Fatal("未配置 WL_ICM_BASE_URL 时应返回 ok=false")
	}
	if parts.Src != nil || parts.Sink != nil || parts.Client != nil {
		t.Fatalf("未启用时不应装配任何部件: %+v", parts)
	}
}

// TestGatewayConfigFromEnvAssembles：配好了就必须真的能装配出部件，
// 并且默认是 dry-run（不写库）——这是既有安全口径，不能被绕开。
func TestGatewayConfigFromEnvAssembles(t *testing.T) {
	srv := fakeICM(t, `{"id":"a","indexCode":"DEV1","monitorTime":"2024-07-05T00:00:00.000+08:00","wl":"1.25"}`)
	t.Setenv("WL_ICM_BASE_URL", srv.URL)
	t.Setenv("WL_ICM_PUSH", "")
	t.Setenv("WL_ICM_TIME_BASIS", "real")
	t.Setenv("WL_ICM_INDEX_CODES", "DEV1, DEV2")
	t.Setenv("WL_ICM_POINT_MAP", "DEV1=S01")
	t.Setenv("WL_ICM_INTERVAL_SEC", "60")

	parts, ok, err := GatewayConfigFromEnv(nil)
	if err != nil {
		t.Fatalf("装配失败: %v", err)
	}
	if !ok {
		t.Fatal("配了 WL_ICM_BASE_URL 应返回 ok=true")
	}
	if parts.Src == nil || parts.Sink == nil || parts.Client == nil {
		t.Fatalf("部件缺失: %+v", parts)
	}
	if !parts.DryRun {
		t.Fatal("默认必须是 dry-run")
	}
	if _, isDry := parts.Sink.(*DryRunSink); !isDry {
		t.Fatalf("默认 sink 应为 DryRunSink，实际 %T", parts.Sink)
	}
	if parts.Interval != time.Minute {
		t.Fatalf("同步周期应取 WL_ICM_INTERVAL_SEC，实际 %s", parts.Interval)
	}
	if parts.Map.Basis != TimeBasisReal {
		t.Fatalf("时间基准不对: %q", parts.Map.Basis)
	}
}

// TestGatewayConfigFromEnvPushOptIn：写库必须显式打开。
func TestGatewayConfigFromEnvPushOptIn(t *testing.T) {
	srv := fakeICM(t, `{"id":"a","indexCode":"DEV1","monitorTime":"2024-07-05T00:00:00.000+08:00","wl":"1.25"}`)
	t.Setenv("WL_ICM_BASE_URL", srv.URL)
	t.Setenv("WL_ICM_TIME_BASIS", "real")
	t.Setenv("WL_ICM_INDEX_CODES", "")
	t.Setenv("WL_ICM_POINT_MAP", "")
	t.Setenv("WL_ICM_INTERVAL_SEC", "")

	cases := []struct {
		name    string
		push    string
		dryRun  bool
		wantErr bool
	}{
		{"显式开启写入", "1", false, false},
		{"true 也算开启", "true", false, false},
		{"0 不算开启", "0", true, false},
		{"空值不算开启", "", true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("WL_ICM_PUSH", tc.push)
			parts, ok, err := GatewayConfigFromEnv(nil)
			if tc.wantErr {
				if err == nil {
					t.Fatal("期望报错")
				}
				return
			}
			if err != nil || !ok {
				t.Fatalf("装配失败: %v ok=%v", err, ok)
			}
			if parts.DryRun != tc.dryRun {
				t.Fatalf("dryRun 期望 %v，实际 %v", tc.dryRun, parts.DryRun)
			}
		})
	}
}

// TestGatewayConfigFromEnvSimulatedNeedsClock：simulated 基准下拿不到
// 仿真时钟就必须拒绝启用——否则写进去的时间戳全是 0，那批数据没法用。
func TestGatewayConfigFromEnvSimulatedNeedsClock(t *testing.T) {
	srv := fakeICM(t, `{"id":"a","indexCode":"DEV1","monitorTime":"2024-07-05T00:00:00.000+08:00","wl":"1.25"}`)
	t.Setenv("WL_ICM_BASE_URL", srv.URL)
	t.Setenv("WL_ICM_PUSH", "")
	t.Setenv("WL_ICM_INDEX_CODES", "")
	t.Setenv("WL_ICM_POINT_MAP", "")
	t.Setenv("WL_ICM_INTERVAL_SEC", "")
	t.Setenv("WL_ICM_TIME_BASIS", "simulated")

	if _, ok, err := GatewayConfigFromEnv(nil); err == nil || ok {
		t.Fatalf("缺仿真时钟时应拒绝启用: ok=%v err=%v", ok, err)
	}

	parts, ok, err := GatewayConfigFromEnv(func() int64 { return 1_700_000_000 })
	if err != nil || !ok {
		t.Fatalf("给了仿真时钟应装配成功: %v ok=%v", err, ok)
	}
	if parts.Map.SimNow == nil {
		t.Fatal("simulated 基准下应注入 SimNow")
	}
	if parts.Map.SimNow() != 1_700_000_000 {
		t.Fatalf("SimNow 应返回 v3 仿真时钟，实际 %d", parts.Map.SimNow())
	}
}

// TestGatewayConfigFromEnvBadBasis：非法时间基准要报错而不是静默按 real 处理。
func TestGatewayConfigFromEnvBadBasis(t *testing.T) {
	srv := fakeICM(t, `{"id":"a","indexCode":"DEV1","monitorTime":"2024-07-05T00:00:00.000+08:00","wl":"1.25"}`)
	t.Setenv("WL_ICM_BASE_URL", srv.URL)
	t.Setenv("WL_ICM_PUSH", "")
	t.Setenv("WL_ICM_INDEX_CODES", "")
	t.Setenv("WL_ICM_POINT_MAP", "")
	t.Setenv("WL_ICM_INTERVAL_SEC", "")
	t.Setenv("WL_ICM_TIME_BASIS", "wallclock")

	if _, ok, err := GatewayConfigFromEnv(nil); err == nil || ok {
		t.Fatalf("非法 timeBasis 应报错: ok=%v err=%v", ok, err)
	}
}

// TestParseIndexCodes：设备编码解析要能容忍空格与空项。
func TestParseIndexCodes(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"空串表示全部", "", nil},
		{"单个", "DEV1", []string{"DEV1"}},
		{"逗号分隔带空格", "DEV1, DEV2 ,DEV3", []string{"DEV1", "DEV2", "DEV3"}},
		{"忽略空项", "DEV1,,DEV2,", []string{"DEV1", "DEV2"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseIndexCodes(tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("期望 %v，实际 %v", tc.want, got)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("期望 %v，实际 %v", tc.want, got)
				}
			}
		})
	}
}

// ---------------------------------------------------------------- 调度

// TestRunStopsOnContextCancel：网关必须能被 ctx 停掉，
// 否则进程退出时会留下一个还在拉数的 goroutine。
func TestRunStopsOnContextCancel(t *testing.T) {
	srv := fakeICM(t, `{"id":"a","indexCode":"DEV1","monitorTime":"2024-07-05T00:00:00.000+08:00","wl":"1.25"}`)
	cfg := testConfig(srv.URL)
	client := NewClient(cfg)
	src := NewRealtimeSource(client, cfg.DeviceType, nil)
	g := NewGateway(cfg, src, &DryRunSink{}, IdentityPointMap{}, MapConfig{}, GatewayOptions{Interval: 50 * time.Millisecond})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		g.Run(ctx)
		close(done)
	}()
	time.Sleep(120 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run 未在 ctx 取消后退出")
	}
	if g.Health().TotalRuns == 0 {
		t.Fatal("Run 应至少执行过一轮")
	}
}
