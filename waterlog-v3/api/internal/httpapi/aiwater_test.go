package httpapi

// 网关（A-*）的单元测试。
//
// 覆盖的是**协议契约**本身，而不是业务算法：
//   - 响应包形状（字符串 code、data 非空、错误时 data 为 null）
//   - 预警四级 → 对外三级的映射
//   - A-9 的三条硬约束：验签、幂等、必返 HTTP 200
//   - A-6 的 requestId 幂等
//
// 为什么这些必须测：它们是**对方 SDK 依赖的契约**。
// 改错了不会在本地报错，只会让对方的 SDK 在生产环境解析失败。

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"waterlog-v3/api/internal/config"
	"waterlog-v3/api/internal/store"
)

// testLogger 造一个丢弃输出的 logger。
//
// handler 里会打日志（验签失败、落库失败），测试里不能让它们污染测试输出。
func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// newTestStore 开一个临时库。
func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.OpenStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("打开测试库失败: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// decodeEnvelope 解网关响应包。
func decodeEnvelope(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("响应不是 JSON: %v（body=%s）", err, w.Body.String())
	}
	return out
}

// ---------------------------------------------------------------- 响应包契约

func TestAIWaterEnvelopeShape(t *testing.T) {
	w := httptest.NewRecorder()
	aiwaterOK(w, map[string]any{"total": 1})
	if w.Code != http.StatusOK {
		t.Fatalf("应返回 200，实际 %d", w.Code)
	}
	out := decodeEnvelope(t, w)

	code, ok := out["code"].(string)
	if !ok {
		t.Fatalf("code 必须是字符串，实际 %T（%v）", out["code"], out["code"])
	}
	if code != "0" {
		t.Fatalf("成功时 code 应为 \"0\"，实际 %q", code)
	}
	if _, ok := out["data"]; !ok {
		t.Fatal("data 字段必须存在（缺失与 null 是两回事）")
	}
	if out["msg"] == nil {
		t.Fatal("msg 字段必须存在")
	}
}

func TestAIWaterEnvelopeErrorDataIsNull(t *testing.T) {
	w := httptest.NewRecorder()
	aiwaterFail(w, http.StatusBadRequest, aiwaterCodeBadRequest, "参数错误")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("应返回 400，实际 %d", w.Code)
	}
	out := decodeEnvelope(t, w)
	if out["code"] != aiwaterCodeBadRequest {
		t.Fatalf("code 应为 %q，实际 %v", aiwaterCodeBadRequest, out["code"])
	}
	v, present := out["data"]
	if !present {
		t.Fatal("data 字段必须存在（错误时写 null，不省略）")
	}
	if v != nil {
		t.Fatalf("错误时 data 应为 null，实际 %v", v)
	}
}

// ---------------------------------------------------------------- 等级映射

func TestAIWaterRiskMapping(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"blue", aiwaterRiskLow},
		{"yellow", aiwaterRiskMedium},
		{"orange", aiwaterRiskHigh},
		{"red", aiwaterRiskHigh},
		{"none", aiwaterRiskLow},
		{"", aiwaterRiskLow},
	}
	for _, c := range cases {
		if got := aiwaterRiskOf(c.in); got != c.want {
			t.Fatalf("%q 应映射为 %q，实际 %q", c.in, c.want, got)
		}
	}
}

func TestAIWaterMatchLevelAcceptsBothScales(t *testing.T) {
	// 对方按三级传、我方按四级存，过滤必须两边都认。
	if !aiwaterMatchLevel("high", "orange") || !aiwaterMatchLevel("high", "red") {
		t.Fatal("三级 high 应命中 orange/red")
	}
	if aiwaterMatchLevel("high", "yellow") {
		t.Fatal("三级 high 不应命中 yellow")
	}
	if !aiwaterMatchLevel("yellow", "yellow") {
		t.Fatal("四级 yellow 应命中 yellow")
	}
	if !aiwaterMatchLevel("", "red") {
		t.Fatal("空过滤条件应命中一切")
	}
	if !aiwaterMatchLevel("low", "none") {
		t.Fatal("三级 low 应命中 none")
	}
}

func TestAIWaterPeriodMinutes(t *testing.T) {
	got := aiwaterPeriodMinutes([]string{"1h", "3h", "6h", "12h"})
	want := []int{60, 180, 360, 720}
	if len(got) != len(want) {
		t.Fatalf("应有 %d 个预见期，实际 %d", len(want), len(got))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("第 %d 个预见期应为 %d，实际 %d", i, want[i], got[i])
		}
	}
	// 空输入 = 全部四个
	if all := aiwaterPeriodMinutes(nil); len(all) != 4 {
		t.Fatalf("空输入应返回全部 4 个预见期，实际 %d", len(all))
	}
	// 无法解析的项被跳过，而不是让整个查询失败
	if mixed := aiwaterPeriodMinutes([]string{"1h", "banana"}); len(mixed) != 1 || mixed[0] != 60 {
		t.Fatalf("非法项应被跳过，实际 %v", mixed)
	}
}

// ---------------------------------------------------------------- A-9 事件接收

// signA9 给报文加签名。
func signA9(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// a9Server 造一个带 store 的最小 Server。
func a9Server(t *testing.T, secret string) *Server {
	t.Helper()
	return &Server{
		cfg:   config.Config{AIWaterEventSecret: secret},
		store: newTestStore(t),
		log:   testLogger(),
	}
}

func TestAIWaterEventReceiveIdempotent(t *testing.T) {
	s := a9Server(t, "")
	body := []byte(`{"eventId":"EV-1","pointCode":"S1","stage":"发现","operator":"张三","operateTime":"2026-11-10T10:00:00.000+08:00"}`)

	w1 := httptest.NewRecorder()
	s.aiwaterEventReceive(w1, httptest.NewRequest(http.MethodPost, "/api/aiwater/v1/event/receive", strings.NewReader(string(body))))
	if w1.Code != http.StatusOK {
		t.Fatalf("首次应返回 200，实际 %d", w1.Code)
	}
	d1 := decodeEnvelope(t, w1)
	data1, _ := d1["data"].(map[string]any)
	if data1["accepted"].(float64) != 1 {
		t.Fatalf("首次应写入 1 条，实际 %v", data1["accepted"])
	}

	// 同一事件再推一次：必须被幂等挡掉。
	w2 := httptest.NewRecorder()
	s.aiwaterEventReceive(w2, httptest.NewRequest(http.MethodPost, "/api/aiwater/v1/event/receive", strings.NewReader(string(body))))
	d2 := decodeEnvelope(t, w2)
	data2, _ := d2["data"].(map[string]any)
	if data2["accepted"].(float64) != 0 {
		t.Fatalf("重复事件不应再写入，实际 accepted=%v", data2["accepted"])
	}
	if data2["duplicate"].(float64) != 1 {
		t.Fatalf("重复事件应计入 duplicate，实际 %v", data2["duplicate"])
	}
}

func TestAIWaterEventReceiveAlwaysHTTP200(t *testing.T) {
	s := a9Server(t, "secret-key")

	// 签名错误：仍必须回 200（否则对方平台判定未送达并无限重试）。
	body := []byte(`{"eventId":"EV-2","pointCode":"S1"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/aiwater/v1/event/receive", strings.NewReader(string(body)))
	req.Header.Set("X-AIWater-Signature", "sha256=deadbeef")
	w := httptest.NewRecorder()
	s.aiwaterEventReceive(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("验签失败也必须返回 200，实际 %d", w.Code)
	}

	// 报文完全不是 JSON：同样 200。
	w2 := httptest.NewRecorder()
	s.aiwaterEventReceive(w2, httptest.NewRequest(http.MethodPost, "/api/aiwater/v1/event/receive", strings.NewReader("not json at all")))
	if w2.Code != http.StatusOK {
		t.Fatalf("报文非法也必须返回 200，实际 %d", w2.Code)
	}
}

func TestAIWaterEventReceiveSignature(t *testing.T) {
	const secret = "shared-secret"
	s := a9Server(t, secret)
	body := []byte(`{"eventId":"EV-3","pointCode":"S1","stage":"复核"}`)

	// 正确签名
	req := httptest.NewRequest(http.MethodPost, "/api/aiwater/v1/event/receive", strings.NewReader(string(body)))
	req.Header.Set("X-AIWater-Signature", signA9(secret, body))
	w := httptest.NewRecorder()
	s.aiwaterEventReceive(w, req)
	d := decodeEnvelope(t, w)
	data, _ := d["data"].(map[string]any)
	if data["signatureVerified"] != true {
		t.Fatalf("正确签名应通过验签，实际 %v", data["signatureVerified"])
	}
	if data["accepted"].(float64) != 1 {
		t.Fatalf("验签通过应写入 1 条，实际 %v", data["accepted"])
	}

	// 错误签名：事件不落库
	body2 := []byte(`{"eventId":"EV-4","pointCode":"S1","stage":"复核"}`)
	req2 := httptest.NewRequest(http.MethodPost, "/api/aiwater/v1/event/receive", strings.NewReader(string(body2)))
	req2.Header.Set("X-AIWater-Signature", signA9("wrong-secret", body2))
	w2 := httptest.NewRecorder()
	s.aiwaterEventReceive(w2, req2)
	d2 := decodeEnvelope(t, w2)
	data2, _ := d2["data"].(map[string]any)
	if data2["accepted"].(float64) != 0 {
		t.Fatalf("验签失败不应写入事件，实际 accepted=%v", data2["accepted"])
	}
	if data2["signatureVerified"] != false {
		t.Fatalf("验签失败应标注 signatureVerified=false，实际 %v", data2["signatureVerified"])
	}
}

func TestAIWaterEventReceiveArrayPayload(t *testing.T) {
	s := a9Server(t, "")
	body := []byte(`[{"eventId":"EV-5","pointCode":"S1","stage":"发现"},{"eventId":"EV-6","pointCode":"S2","stage":"核销"}]`)
	w := httptest.NewRecorder()
	s.aiwaterEventReceive(w, httptest.NewRequest(http.MethodPost, "/api/aiwater/v1/event/receive", strings.NewReader(string(body))))
	d := decodeEnvelope(t, w)
	data, _ := d["data"].(map[string]any)
	if data["accepted"].(float64) != 2 {
		t.Fatalf("数组报文应写入 2 条，实际 %v", data["accepted"])
	}
}

// ---------------------------------------------------------------- A-6 任务幂等

func TestAIWaterTaskSubmitIdempotent(t *testing.T) {
	s := &Server{
		cfg:          config.Config{},
		store:        newTestStore(t),
		svc:          nil,
		log:          testLogger(),
		aiwaterQueue: make(chan string, 4),
	}
	body := `{"requestId":"REQ-1","pointCodes":["S1"],"periods":["1h"]}`

	w1 := httptest.NewRecorder()
	s.aiwaterTaskSubmit(w1, httptest.NewRequest(http.MethodPost, "/api/aiwater/v1/prediction/task/submit", strings.NewReader(body)))
	if w1.Code != http.StatusOK {
		t.Fatalf("应返回 200，实际 %d（body=%s）", w1.Code, w1.Body.String())
	}
	d1 := decodeEnvelope(t, w1)
	data1, _ := d1["data"].(map[string]any)
	taskID1, _ := data1["taskId"].(string)
	if taskID1 == "" {
		t.Fatalf("应返回 taskId，实际 %v", data1)
	}
	if data1["duplicate"] != false {
		t.Fatalf("首次提交不应是重复，实际 %v", data1["duplicate"])
	}
	if data1["status"] != "queued" {
		t.Fatalf("首次提交状态应为 queued，实际 %v", data1["status"])
	}

	// 同一个 requestId 再提交：必须拿到同一个 taskId
	w2 := httptest.NewRecorder()
	s.aiwaterTaskSubmit(w2, httptest.NewRequest(http.MethodPost, "/api/aiwater/v1/prediction/task/submit", strings.NewReader(body)))
	d2 := decodeEnvelope(t, w2)
	data2, _ := d2["data"].(map[string]any)
	taskID2, _ := data2["taskId"].(string)
	if taskID2 != taskID1 {
		t.Fatalf("相同 requestId 应返回相同 taskId，实际 %q vs %q", taskID1, taskID2)
	}
	if data2["duplicate"] != true {
		t.Fatalf("重复提交应标注 duplicate=true，实际 %v", data2["duplicate"])
	}
}

func TestAIWaterTaskSubmitRequiresRequestId(t *testing.T) {
	s := &Server{
		cfg:          config.Config{},
		store:        newTestStore(t),
		log:          testLogger(),
		aiwaterQueue: make(chan string, 4),
	}
	w := httptest.NewRecorder()
	s.aiwaterTaskSubmit(w, httptest.NewRequest(http.MethodPost, "/api/aiwater/v1/prediction/task/submit", strings.NewReader(`{"pointCodes":["S1"]}`)))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("缺 requestId 应返回 400，实际 %d", w.Code)
	}
	d := decodeEnvelope(t, w)
	if d["code"] != aiwaterCodeBadRequest {
		t.Fatalf("code 应为 %q，实际 %v", aiwaterCodeBadRequest, d["code"])
	}
}

// ---------------------------------------------------------------- 鉴权中间件

func TestRequireAIWaterToken(t *testing.T) {
	handler := RequireAIWaterToken("secret")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		aiwaterOK(w, map[string]any{"ok": true})
	}))

	// 无令牌
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/x", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("无令牌应返回 401，实际 %d", w.Code)
	}

	// Bearer 正确
	req := httptest.NewRequest(http.MethodPost, "/x", nil)
	req.Header.Set("Authorization", "Bearer secret")
	w2 := httptest.NewRecorder()
	handler.ServeHTTP(w2, req)
	if w2.Code != http.StatusOK {
		t.Fatalf("Bearer 正确应返回 200，实际 %d", w2.Code)
	}

	// 自定义头正确
	req3 := httptest.NewRequest(http.MethodPost, "/x", nil)
	req3.Header.Set("X-AIWater-Token", "secret")
	w3 := httptest.NewRecorder()
	handler.ServeHTTP(w3, req3)
	if w3.Code != http.StatusOK {
		t.Fatalf("X-AIWater-Token 正确应返回 200，实际 %d", w3.Code)
	}

	// 空 token = 放行（本机演示态）
	open := RequireAIWaterToken("")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		aiwaterOK(w, map[string]any{"ok": true})
	}))
	w4 := httptest.NewRecorder()
	open.ServeHTTP(w4, httptest.NewRequest(http.MethodPost, "/x", nil))
	if w4.Code != http.StatusOK {
		t.Fatalf("未配置 token 时应放行，实际 %d", w4.Code)
	}
}
