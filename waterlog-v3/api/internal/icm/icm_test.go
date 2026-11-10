package icm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"waterlog-v3/api/internal/domain"
)

// 本测试用 httptest 模拟 ICM 平台响应，验证「按对方原样复用」的协议差异确实
// 被消化：code 类型混用、分页壳 String 数值、动态监测项字段、时间格式、
// 双时钟映射、ingest 不凭 HTTP 200 判成功。
// 这不等于与真实平台联调（无地址/凭据），只验证本地链路正确性。

func testConfig(base string) Config {
	return Config{
		BaseURL:     base,
		Timeout:     2 * time.Second,
		PageSize:    2,
		MaxPages:    5,
		Retry:       1,
		RetryBase:   time.Millisecond,
		DeviceType:  "waterLevelGauge",
		MonitorItem: "wl",
		IngestURL:   "http://127.0.0.1:1/api/ingest/telemetry",
	}.normalize()
}

func writeEnv(w http.ResponseWriter, code string, data string) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"code":` + code + `,"msg":"test","data":` + data + `}`))
}

// ---------------------------------------------------------------- code 归一化

func TestCodeNormalization(t *testing.T) {
	cases := []struct {
		name string
		code string
		ok   bool
	}{
		{"字符串0", `"0"`, true},
		{"数字0", `0`, true},
		{"数字0.0", `0.0`, true},
		{"字符串500", `"500"`, false},
		{"数字500", `500`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				writeEnv(w, tc.code, `{"url":"rtsp://x"}`)
			}))
			defer srv.Close()
			c := NewClient(testConfig(srv.URL))
			out, err := c.GetPreviewURL(context.Background(), PreviewURLQuery{CameraIndexCode: "cam1"})
			if (err == nil) != tc.ok {
				t.Fatalf("code=%s 期望成功=%v，实际 err=%v", tc.code, tc.ok, err)
			}
			if tc.ok && out.URL != "rtsp://x" {
				t.Fatalf("data 未解出: %+v", out)
			}
		})
	}
}

// 业务 code != "0" 不重试（§3.5）
func TestBusinessErrorNotRetried(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		writeEnv(w, `"400"`, `null`)
	}))
	defer srv.Close()
	c := NewClient(testConfig(srv.URL))
	c.SetRequestIDFactory(func() string { return "fixed-id" })
	err := c.Do(context.Background(), http.MethodPost, PathDictFirstLayer, map[string]any{"typeCode": "x"}, nil)
	if err == nil {
		t.Fatal("业务失败应返回错误")
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("业务错误不应重试，实际请求 %d 次", n)
	}
	var ae *APIError
	if !asAPIError(err, &ae) || ae.Code != "400" {
		t.Fatalf("期望 APIError code=400，实际 %v", err)
	}
}

// 5xx 重试后可成功
func TestRetryOn5xx(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			writeEnv(w, `"503"`, `null`)
			return
		}
		writeEnv(w, `"0"`, `{"url":"ok"}`)
	}))
	defer srv.Close()
	c := NewClient(testConfig(srv.URL))
	var out PreviewURLResult
	if err := c.Do(context.Background(), http.MethodPost, PathPreviewURLs, PreviewURLQuery{}, &out); err != nil {
		t.Fatalf("重试后应成功: %v", err)
	}
	if out.URL != "ok" {
		t.Fatalf("data=%+v", out)
	}
}

// ---------------------------------------------------------------- 链路头与 token 插件位

func TestHeadersAndTokenProvider(t *testing.T) {
	var gotReqID, gotTrace, gotAuth, gotContentType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotReqID = r.Header.Get("X-Request-Id")
		gotTrace = r.Header.Get("X-Trace-Id")
		gotAuth = r.Header.Get("Authorization")
		gotContentType = r.Header.Get("Content-Type")
		writeEnv(w, `"0"`, `{}`)
	}))
	defer srv.Close()
	cfg := testConfig(srv.URL)
	cfg.Token = TokenFunc(func(context.Context) (string, error) { return "Bearer tk-1", nil })
	c := NewClient(cfg)
	c.SetRequestIDFactory(func() string { return "req-abc" })
	if err := c.Do(context.Background(), http.MethodPost, PathDictFirstLayer, map[string]any{}, nil); err != nil {
		t.Fatal(err)
	}
	if gotReqID != "req-abc" || gotTrace != "req-abc" {
		t.Fatalf("链路头未透传: req=%s trace=%s", gotReqID, gotTrace)
	}
	if gotAuth != "Bearer tk-1" {
		t.Fatalf("token 插件位未生效: %s", gotAuth)
	}
	if gotContentType != "application/json" {
		t.Fatalf("Content-Type=%s", gotContentType)
	}
}

// ---------------------------------------------------------------- 分页 + String 数值 + 动态字段

func TestRealtimePagingAndDynamicField(t *testing.T) {
	var pages []int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var q MonitorDataQuery
		_ = json.NewDecoder(r.Body).Decode(&q)
		pages = append(pages, q.PageNo)
		if q.DeviceType != "waterLevelGauge" {
			t.Errorf("deviceType 未按对方字段发出: %q", q.DeviceType)
		}
		switch q.PageNo {
		case 1:
			// pageNo/pageSize 出参为 String（§3.3 差异 2）；R1 监测值为 String
			writeEnv(w, `"0"`, `{"total":"3","pageNo":"1","pageSize":"2","list":[
				{"id":"a","indexCode":"DEV1","monitorTime":"2024-07-05T00:00:00.000+08:00","wl":"1.25"},
				{"id":"b","indexCode":"DEV2","monitorTime":"2024-07-05T00:05:00.000+08:00","wl":"2.50"}]}`)
		case 2:
			writeEnv(w, `0`, `{"total":"3","pageNo":"2","pageSize":"2","list":[
				{"id":"c","indexCode":"DEV1","monitorTime":"2024-07-05T00:10:00.000+08:00","wl":"1.80"}]}`)
		default:
			writeEnv(w, `"0"`, `{"total":"3","list":[]}`)
		}
	}))
	defer srv.Close()
	c := NewClient(testConfig(srv.URL))
	rows, err := c.QueryRealtimeData(context.Background(), MonitorDataQuery{DeviceType: c.Config().DeviceType})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 {
		t.Fatalf("期望 3 条，实际 %d", len(rows))
	}
	if len(pages) != 2 {
		t.Fatalf("应在取够 total 后停止，实际请求页 %v", pages)
	}
	v, ok := rows[0].ValueOf("wl")
	if !ok || v != 1.25 {
		t.Fatalf("动态监测项字段（String）取值失败: %v %v", v, ok)
	}
}

// R2 历史数据监测值为 Number
func TestHistoryNumberField(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeEnv(w, `"0"`, `{"total":1,"pageNo":1,"pageSize":2,"list":[
			{"id":"a","indexCode":"DEV1","monitorTime":"2024-07-05T00:00:00.000+08:00","wl":3.75}]}`)
	}))
	defer srv.Close()
	c := NewClient(testConfig(srv.URL))
	rows, err := c.QueryHistoryData(context.Background(), MonitorDataQuery{DeviceType: "waterLevelGauge"})
	if err != nil {
		t.Fatal(err)
	}
	v, ok := rows[0].ValueOf("wl")
	if !ok || v != 3.75 {
		t.Fatalf("动态监测项字段（Number）取值失败: %v %v", v, ok)
	}
}

// R6 无分页参数；R9 无 expireTime；R12 回调方式无返回值
func TestNonStandardEndpoints(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case PathSubRegions:
			var q map[string]any
			_ = json.NewDecoder(r.Body).Decode(&q)
			if _, has := q["pageNo"]; has {
				t.Error("R6 不应带 pageNo")
			}
			writeEnv(w, `"0"`, `[{"indexCode":"R1","name":"黄岩区","treeCode":"0"}]`)
		case PathEventSubscription:
			writeEnv(w, `"0"`, `null`) // 回调方式 data 无返回值
		default:
			writeEnv(w, `"0"`, `{}`)
		}
	}))
	defer srv.Close()
	c := NewClient(testConfig(srv.URL))
	regs, err := c.ListSubRegions(context.Background(), "0", "0")
	if err != nil || len(regs) != 1 || regs[0].Name != "黄岩区" {
		t.Fatalf("R6 解析失败: %+v %v", regs, err)
	}
	mqtt, err := c.SubscribeEvents(context.Background(), EventSubscription{
		EventTypes: []string{"900001"}, SubWay: 1, EventDest: "https://ai/callback", SubType: 2,
	})
	if err != nil || mqtt != nil {
		t.Fatalf("R12 回调方式应返回 nil: %+v %v", mqtt, err)
	}
}

// GET + Query（R19）按原件发送
func TestGetQueryEndpoint(t *testing.T) {
	var gotOrg string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("R19 应为 GET，实际 %s", r.Method)
		}
		gotOrg = r.URL.Query().Get("orgIndexCode")
		writeEnv(w, `"0"`, `{"thresholdList":[]}`)
	}))
	defer srv.Close()
	c := NewClient(testConfig(srv.URL))
	_, err := c.QuerySensorThreshold(context.Background(), "ORG1", url.Values{"sensorTypes": {"1"}})
	if err != nil {
		t.Fatal(err)
	}
	if gotOrg != "ORG1" {
		t.Fatalf("orgIndexCode 未发出: %q", gotOrg)
	}
}

// ---------------------------------------------------------------- 时间格式

func TestTimeFormat(t *testing.T) {
	in := "2024-07-05T00:00:00.000+08:00"
	tm, err := ParseICMTime(in)
	if err != nil {
		t.Fatal(err)
	}
	if got := FormatICMTime(tm); got != in {
		t.Fatalf("往返格式不一致: %s", got)
	}
	for _, s := range []string{
		"2024-07-05T00:00:00+08:00",
		"2024-07-05T00:00:00.000",
		"2024-07-05 00:00:00",
	} {
		if _, err := ParseICMTime(s); err != nil {
			t.Errorf("应兼容 %q: %v", s, err)
		}
	}
	if _, err := ParseICMTime("not-a-time"); err == nil {
		t.Error("非法时间应报错")
	}
}

// ---------------------------------------------------------------- 映射与双时钟

func TestMapRealtime(t *testing.T) {
	cfg := testConfig("http://unused")
	points := ParsePointMap("DEV1=S01,DEV2=S02")
	records := []MonitorRecord{
		{IndexCode: "DEV1", MonitorTime: "2024-07-05T00:00:00.000+08:00"},
		{IndexCode: "DEV2", MonitorTime: "2024-07-05T00:05:00.000+08:00"},
		{IndexCode: "UNKNOWN", MonitorTime: "2024-07-05T00:05:00.000+08:00"},
		{IndexCode: "DEV1", MonitorTime: "bad-time"},
	}
	for i := range records {
		records[i].Raw = map[string]json.RawMessage{
			"wl": json.RawMessage(`"1.20"`),
		}
	}
	// 有效的三条，其中一条时间错误 → 期望输出 2 条
	batch, rep := MapRealtime(records, cfg, points, MapConfig{})
	if len(batch.Rows) != 2 {
		t.Fatalf("期望 2 行，实际 %d（rep=%+v）", len(batch.Rows), rep)
	}
	if rep.SkippedCode != 1 || rep.SkippedTime != 1 {
		t.Fatalf("跳过统计不对: %+v", rep)
	}
	if rep.TimeBasis != string(TimeBasisReal) {
		t.Fatalf("timeBasis 应为 real: %+v", rep)
	}
	if !strings.Contains(strings.Join(rep.Warnings, " "), "timeBasis") &&
		len(rep.Warnings) == 0 {
		t.Fatal("应带双时钟告警")
	}
	if batch.Rows[0].SiteID != "S01" || batch.Rows[0].Level != 1.20 {
		t.Fatalf("映射值不对: %+v", batch.Rows[0])
	}
	// 用标准库算期望值，不手写魔数：2024-07-05T00:00:00+08:00
	wantTS, err := ParseICMTime("2024-07-05T00:00:00.000+08:00")
	if err != nil {
		t.Fatal(err)
	}
	if batch.Rows[0].TS != wantTS.Unix() {
		t.Fatalf("真实时间戳换算错误: got=%d want=%d", batch.Rows[0].TS, wantTS.Unix())
	}
}

func TestMapRealtimeSimulatedBasis(t *testing.T) {
	cfg := testConfig("http://unused")
	now := int64(1825886945)
	records := []MonitorRecord{{IndexCode: "DEV1", MonitorTime: "2024-07-05T00:00:00.000+08:00"}}
	records[0].Raw = map[string]json.RawMessage{"wl": json.RawMessage(`1.5`)}
	batch, rep := MapRealtime(records, cfg, IdentityPointMap{}, MapConfig{
		Basis:  TimeBasisSimulated,
		SimNow: func() int64 { return now },
	})
	if rep.TimeBasis != "simulated" || len(batch.Rows) != 1 || batch.Rows[0].TS != now {
		t.Fatalf("仿真基准应对齐 SimNow: rep=%+v rows=%+v", rep, batch.Rows)
	}
}

// ---------------------------------------------------------------- ingest 与 dry-run

func TestIngestSinkChecksBodyNotJustHTTP200(t *testing.T) {
	var gotToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("X-Ingest-Token")
		var b domain.TelemetryBatch
		_ = json.NewDecoder(r.Body).Decode(&b)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		// 故意只回 HTTP 200 但 ok=false，验证「不凭 200 判成功」
		_, _ = w.Write([]byte(`{"ok":false,"error":"rejected"}`))
	}))
	defer srv.Close()
	cfg := testConfig("http://unused")
	cfg.IngestURL = srv.URL
	cfg.IngestToken = "secret"
	sink := NewIngestSink(cfg)
	err := sink.Push(context.Background(), domain.TelemetryBatch{Rows: []domain.TelemetryRow{{SiteID: "S01"}}})
	if err == nil {
		t.Fatal("HTTP 200 但 ok=false 时必须判失败")
	}
	if gotToken != "secret" {
		t.Fatalf("X-Ingest-Token 未透传: %q", gotToken)
	}
}

func TestDryRunNeverPushes(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		writeEnv(w, `"0"`, `{"total":0,"list":[]}`)
	}))
	defer srv.Close()
	cfg := testConfig(srv.URL)
	client := NewClient(cfg)
	src := NewRealtimeSource(client, cfg.DeviceType, nil)
	dry := &DryRunSink{}
	rep, err := SyncOnce(context.Background(), src, cfg, IdentityPointMap{}, MapConfig{}, dry)
	if err != nil {
		t.Fatal(err)
	}
	if !rep.DryRun || dry.Rows != 0 {
		t.Fatalf("dry-run 标记/写入不对: rep=%+v rows=%d", rep, dry.Rows)
	}
	// 只有一次取数请求，绝不能出现 ingest 写入请求（本测试里 ingest 指向 127.0.0.1:1）
	if calls.Load() != 1 {
		t.Fatalf("取数请求次数异常: %d", calls.Load())
	}
}

func TestDisabledClientDoesNotCall(t *testing.T) {
	c := NewClient(Config{}.normalize())
	_, err := c.GetPreviewURL(context.Background(), PreviewURLQuery{CameraIndexCode: "x"})
	if err == nil || !strings.Contains(err.Error(), "未启用") {
		t.Fatalf("未配置 BaseURL 应拒绝调用，实际 %v", err)
	}
}
