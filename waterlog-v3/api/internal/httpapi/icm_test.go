package httpapi

// ICM 健康端点的测试：确认「未启用」也返回 200 + 明确状态，
// 以及启用后快照字段确实被吐出来（而不是一个空对象）。
//
// 这里只测 handler 本身，不起完整路由树——鉴权中间件的行为由
// authmw.go 负责，端点挂在哪个段由 router.go 负责，两者都不在本测试范围。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"waterlog-v3/api/internal/icm"
)

// fakeGateway 是一个只提供健康快照的假网关。
type fakeGateway struct {
	status icm.HealthStatus
}

func (f fakeGateway) Health() icm.HealthStatus { return f.status }

func TestICMHealthNotEnabled(t *testing.T) {
	s := &Server{} // gw 为 nil = 网关未启用
	w := httptest.NewRecorder()
	s.icmHealth(w, httptest.NewRequest(http.MethodGet, "/api/icm/health", nil))

	if w.Code != http.StatusOK {
		t.Fatalf("未启用时应返回 200，实际 %d", w.Code)
	}
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if out["status"] != "not_enabled" {
		t.Fatalf("未启用时 status 应为 not_enabled，实际 %v", out["status"])
	}
	if out["enabled"] != false {
		t.Fatalf("未启用时 enabled 应为 false，实际 %v", out["enabled"])
	}
	if msg, _ := out["message"].(string); msg == "" {
		t.Fatal("未启用时应有明确说明文案")
	}
}

func TestICMHealthEnabled(t *testing.T) {
	s := &Server{gw: fakeGateway{status: icm.HealthStatus{
		Enabled:     true,
		IntervalSec: 300,
		TotalRuns:   12,
		Degraded:    false,
		LastRows:    10,
	}}}
	w := httptest.NewRecorder()
	s.icmHealth(w, httptest.NewRequest(http.MethodGet, "/api/icm/health", nil))

	if w.Code != http.StatusOK {
		t.Fatalf("应返回 200，实际 %d", w.Code)
	}
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if out["status"] != "ok" {
		t.Fatalf("正常时 status 应为 ok，实际 %v", out["status"])
	}
	if out["enabled"] != true {
		t.Fatalf("启用时 enabled 应为 true，实际 %v", out["enabled"])
	}
	if out["intervalSec"].(float64) != 300 {
		t.Fatalf("intervalSec 未透出: %v", out["intervalSec"])
	}
	if out["totalRuns"].(float64) != 12 {
		t.Fatalf("totalRuns 未透出: %v", out["totalRuns"])
	}
}

func TestICMHealthDegraded(t *testing.T) {
	s := &Server{gw: fakeGateway{status: icm.HealthStatus{
		Enabled:          true,
		Degraded:         true,
		ConsecutiveFails: 3,
		LastError:        "ICM 取数失败",
	}}}
	w := httptest.NewRecorder()
	s.icmHealth(w, httptest.NewRequest(http.MethodGet, "/api/icm/health", nil))

	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if out["status"] != "degraded" {
		t.Fatalf("降级时 status 应为 degraded，实际 %v", out["status"])
	}
	if out["lastError"] != "ICM 取数失败" {
		t.Fatalf("lastError 未透出: %v", out["lastError"])
	}
}
