// 端到端最小测试集：算法核心（kernel/naive/CI/融合权重/修正）+ 契约接口 httptest。
package main

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"waterlog/backend/internal/agent"
	"waterlog/backend/internal/config"
	"waterlog/backend/internal/datasource"
	"waterlog/backend/internal/forecast"
	"waterlog/backend/internal/httpapi"
	"waterlog/backend/internal/scheduler"
	"waterlog/backend/internal/service"
	"waterlog/backend/internal/sim"
	"waterlog/backend/internal/store"
)

// ---------- 算法：build_kernel ----------
func TestBuildKernel(t *testing.T) {
	k := forecast.BuildKernel(12, 5.0)
	if len(k) != 12 {
		t.Fatalf("kernel len = %d, want 12", len(k))
	}
	sum := 0.0
	for _, w := range k {
		sum += w
	}
	if math.Abs(sum-1.0) > 1e-12 {
		t.Fatalf("kernel sum = %v, want 1", sum)
	}
	// 权重应先增后减（τ=5, len=12 时峰值在 i=5）
	if k[5] <= k[2] || k[5] <= k[11] {
		t.Fatalf("kernel shape wrong: k2=%v k5=%v k11=%v", k[2], k[5], k[11])
	}
}

// ---------- 算法：naive 持久性公式 ----------
func TestNaiveFormula(t *testing.T) {
	p := forecast.DefaultModelParams()
	p.BaseLevel = 1.0
	p.Decay = 0.08
	m := forecast.NewNaiveModel(p)
	now := time.Now()
	window := []forecast.Obs{
		{Ts: now.Add(-10 * time.Minute), Level: 1.5, RainObserved: 0.2},
		{Ts: now.Add(-5 * time.Minute), Level: 1.6, RainObserved: 0.1},
	}
	res, err := m.Predict(window, 60)
	if err != nil {
		t.Fatal(err)
	}
	// 期望：lvl = 1.6 + (1.0-1.6)·0.08·(1·60/60) = 1.552
	want := 1.6 + (1.0-1.6)*0.08*1.0
	if math.Abs(res.Points[len(res.Points)-1].LevelRaw-want) > 1e-9 {
		t.Fatalf("naive = %v, want %v", res.Points[len(res.Points)-1].LevelRaw, want)
	}
}

// ---------- 算法：effective_ci ----------
func TestEffectiveCI(t *testing.T) {
	// rmse>0：rmse·√h·factor·6
	got := forecast.EffectiveCI(0.02, 0.1, true, 1.0, 0.06)
	want := math.Max(0.01, 0.1*math.Sqrt(math.Max(1.0, 0.25))*0.06*6.0)
	if math.Abs(got-want) > 1e-12 {
		t.Fatalf("ci = %v, want %v", got, want)
	}
	// rmse 缺失：base·(1+0.9·√h)
	got = forecast.EffectiveCI(0.02, 0, false, 1.0, 0.06)
	want = 0.02 * (1 + 0.9*math.Sqrt(math.Max(1.0, 0.25)))
	if math.Abs(got-want) > 1e-12 {
		t.Fatalf("ci = %v, want %v", got, want)
	}
}

// ---------- 算法：D2 融合权重（经 Decide 全链路） ----------
func TestFusionWeights(t *testing.T) {
	orch := agent.NewOrchestrator(config.Default().Revision)
	ctx := &agent.ForecastContext{
		StationID: 1, StationCode: "S001", LeadHours: 6,
		HistoryRows: 100, MinRows: 72, Innovation: 0,
		Quality: agent.SourceQuality{Status: "STREAMING", MissingRate: 0.1,
			LastSampleAgeMin: 6, RecentRMSE: nil, RainBias: 0.2},
		ActiveModelType: "linear_response",
	}
	d := orch.Decide(ctx)
	w := d.FusionWeights
	sum := w.Level + w.Rain + w.Fcst
	if math.Abs(sum-1.0) > 0.005 {
		t.Fatalf("weights sum = %v", sum)
	}
	// w_level=1/(1+3·0.1+min(6/60,1))=1/1.4; w_rain=1/1.2; w_fcst=1/(1+0.25·6/12)=1/1.125
	wl := (1.0 / 1.4) / (1.0/1.4+1.0/1.2+1.0/1.125)
	if math.Abs(w.Level-forecast.RoundN(wl, 3)) > 1e-9 {
		t.Fatalf("w.Level = %v, want %v", w.Level, forecast.RoundN(wl, 3))
	}
}

// ---------- 算法：revision apply ----------
func TestRevisionApply(t *testing.T) {
	rev := service.NewRevisionService(config.Default().Revision)
	now := time.Now()
	raw := []forecast.PointResult{
		{T: now, LevelRaw: 1.5, Lower: 1.4, Upper: 1.6},
		{T: now.Add(30 * time.Minute), LevelRaw: 1.6, Lower: 1.45, Upper: 1.75},
	}
	d := &agent.Decision{SelectedModel: "linear_response",
		FusionWeights: agent.FusionWeights{Level: 0.45, Rain: 0.35, Fcst: 0.2},
		RevisionAlpha: 0.3, CiScale: 1.0}
	out := rev.Apply(raw, d, now, 0.02, 0.0, 0.0, 0.0, 5)
	if len(out) != 2 {
		t.Fatalf("len = %d", len(out))
	}
	// e = 0.45·0.02 = 0.009；ρ=0.85, Δt=0 → revision=0.3·0.009=0.0027
	if math.Abs(out[0].Revision-0.0027) > 1e-9 {
		t.Fatalf("revision[0] = %v, want 0.0027", out[0].Revision)
	}
}

// ---------- 接口契约：httptest 全链路 ----------
func setupAPI(t *testing.T) *httptest.Server {
	t.Helper()
	dir, err := os.MkdirTemp("", "waterlog-test-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	cfg := config.Default()
	cfg.DBPath = filepath.Join(dir, "test.db")
	st, err := store.Open(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.Seed(time.Now()); err != nil {
		t.Fatal(err)
	}
	om := datasource.NewOpenMeteoClient()
	src := datasource.NewSimulatedSource(st, om, false, cfg.Datasource.StaleAfterMinutes)
	bus := service.NewBus()
	alerts := service.NewAlertService(cfg.Alert, st, bus)
	orch := agent.NewOrchestrator(cfg.Revision)
	rev := service.NewRevisionService(cfg.Revision)
	fc := service.NewForecastService(cfg, st, alerts, orch, rev, src)
	calib := service.NewCalibrationService(cfg, st)
	pub := service.NewPublishService(st, bus)
	gen := sim.NewGenerator(st, forecast.BuildParams(&cfg.Forecast, nil, "", 0), cfg.Forecast.StepMinutes)
	// 预置样本：catch-up 生成 6h 观测
	if n := gen.CatchUp(time.Now()); n == 0 {
		t.Fatal("catch-up generated no samples")
	}
	sched := scheduler.New(cfg, fc, gen)
	api := httpapi.NewAPI(cfg, st, fc, alerts, calib, pub, bus, gen, sched, src)
	srv := httptest.NewServer(api.Router())
	t.Cleanup(srv.Close)
	return srv
}

type resp struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

func getJSON(t *testing.T, url string) resp {
	t.Helper()
	r, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatalf("GET %s status = %d", url, r.StatusCode)
	}
	var out resp
	if err := json.NewDecoder(r.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestContractEndpoints(t *testing.T) {
	srv := setupAPI(t)
	base := srv.URL + "/api/v1"

	// 1. system/status
	if r := getJSON(t, base+"/system/status"); r.Code != 0 {
		t.Fatalf("system/status code=%d msg=%s", r.Code, r.Message)
	}
	// 2. alert-levels：camelCase 字段
	r := getJSON(t, base+"/alert-levels")
	if r.Code != 0 || !strings.Contains(string(r.Data), "levelKey") ||
		!strings.Contains(string(r.Data), "waterLevelThreshold") {
		t.Fatalf("alert-levels contract fail: %s", string(r.Data)[:min(300, len(r.Data))])
	}
	// 3. forecast/leads
	if r := getJSON(t, base+"/forecast/leads"); r.Code != 0 ||
		!strings.Contains(string(r.Data), "defaultWeight") {
		t.Fatalf("forecast/leads contract fail")
	}
	// 4. stations：含 currentLevel/trend/thresholds
	r = getJSON(t, base+"/stations")
	if r.Code != 0 || !strings.Contains(string(r.Data), "currentLevel") ||
		!strings.Contains(string(r.Data), "thresholds") || !strings.Contains(string(r.Data), "trend") {
		t.Fatalf("stations contract fail")
	}
	var items []map[string]any
	var page struct {
		Items []map[string]any `json:"items"`
		Total int              `json:"total"`
	}
	if err := json.Unmarshal(r.Data, &items); err == nil {
		// 列表直返形态
	} else if err := json.Unmarshal(r.Data, &page); err == nil {
		items = page.Items
	} else {
		t.Fatal(err)
	}
	if len(items) != 6 {
		t.Fatalf("stations = %d, want 6", len(items))
	}
	stID := int64(items[0]["stationId"].(float64))
	// 5. station series
	r = getJSON(t, base+"/stations/"+itoa(int(stID))+"/series?hours=1")
	if r.Code != 0 || !strings.Contains(string(r.Data), "rainObserved") {
		t.Fatalf("series contract fail")
	}
	// 6. station predict（POST 空 body）
	resp2, err := http.Post(base+"/stations/"+itoa(int(stID))+"/predict", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	var pr resp
	if err := json.NewDecoder(resp2.Body).Decode(&pr); err != nil {
		t.Fatal(err)
	}
	if pr.Code != 0 || !strings.Contains(string(pr.Data), "points") ||
		!strings.Contains(string(pr.Data), "waterLevel") {
		t.Fatalf("predict fail code=%d msg=%s", pr.Code, pr.Message)
	}
	var pred struct {
		ForecastID int64 `json:"forecastId"`
		Points     []struct {
			Time string `json:"time"`
		} `json:"points"`
	}
	if err := json.Unmarshal(pr.Data, &pred); err != nil {
		t.Fatal(err)
	}
	if len(pred.Points) == 0 {
		t.Fatal("predict has no points")
	}
	// 7. forecast comparison
	r = getJSON(t, base+"/forecasts/"+itoa(int(pred.ForecastID))+"/comparison")
	if r.Code != 0 || !strings.Contains(string(r.Data), "metrics") {
		t.Fatalf("comparison fail: %s", string(r.Data)[:min(200, len(r.Data))])
	}
	// 8. forecast decision
	r = getJSON(t, base+"/forecasts/"+itoa(int(pred.ForecastID))+"/decision")
	if r.Code != 0 || !strings.Contains(string(r.Data), "fusionWeights") {
		t.Fatalf("decision fail")
	}
	// 9. alerts 列表（分页字段）
	r = getJSON(t, base+"/alerts?page=1&pageSize=10")
	if r.Code != 0 || !strings.Contains(string(r.Data), "pageSize") {
		t.Fatalf("alerts fail")
	}
	// 10. alerts/stats
	if r := getJSON(t, base+"/alerts/stats"); r.Code != 0 ||
		!strings.Contains(string(r.Data), "effectiveTotal") {
		t.Fatalf("alerts/stats fail")
	}
	// 11. datasources
	if r := getJSON(t, base+"/datasources"); r.Code != 0 ||
		!strings.Contains(string(r.Data), "refreshIntervalSec") {
		t.Fatalf("datasources fail")
	}
	// 12. publish-channels
	if r := getJSON(t, base+"/publish-channels"); r.Code != 0 {
		t.Fatalf("publish-channels fail")
	}
	// 13. models
	r = getJSON(t, base+"/models")
	if r.Code != 0 || !strings.Contains(string(r.Data), "activatable") {
		t.Fatalf("models fail")
	}
	// 14. health / health/detail
	if r := getJSON(t, base+"/health"); r.Code != 0 {
		t.Fatalf("health fail")
	}
	r = getJSON(t, base+"/health/detail")
	if r.Code != 0 || !strings.Contains(string(r.Data), "scheduler") ||
		!strings.Contains(string(r.Data), "datasource") {
		t.Fatalf("health/detail fail")
	}
	// 15. sim/events 注入
	resp3, err := http.Post(base+"/sim/events", "application/json",
		strings.NewReader(`{"stationId":`+itoa(int(stID))+`,"intensity":"heavy"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp3.Body.Close()
	var sr resp
	_ = json.NewDecoder(resp3.Body).Decode(&sr)
	if sr.Code != 0 || !strings.Contains(string(sr.Data), "eventId") {
		t.Fatalf("sim/events fail code=%d msg=%s", sr.Code, sr.Message)
	}
	// 16. 404 业务码：STATION_NOT_FOUND
	r = getJSON(t, base+"/stations/99999")
	if r.Code != 1102 {
		t.Fatalf("station not found code = %d, want 1102", r.Code)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	b := []byte{}
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		return "-" + string(b)
	}
	return string(b)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
