package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"waterlog/backend/internal/agent"
	"waterlog/backend/internal/config"
	"waterlog/backend/internal/datasource"
	"waterlog/backend/internal/forecast"
	"waterlog/backend/internal/scheduler"
	"waterlog/backend/internal/service"
	"waterlog/backend/internal/sim"
	"waterlog/backend/internal/store"
)

func TestCORSWhitelist(t *testing.T) {
	dir, err := os.MkdirTemp("", "waterlog-cors-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	cfg := config.Default()
	cfg.DBPath = filepath.Join(dir, "test.db")
	st, err := store.Open(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
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
	sched := scheduler.New(cfg, fc, gen)
	api := NewAPI(cfg, st, fc, alerts, calib, pub, bus, gen, sched, src)

	// 测试 1：默认白名单允许 localhost
	req1 := httptest.NewRequest("OPTIONS", "/api/v1/health", nil)
	req1.Header.Set("Origin", "http://localhost:5173")
	req1.Header.Set("Access-Control-Request-Method", "GET")
	w1 := httptest.NewRecorder()
	api.Router().ServeHTTP(w1, req1)
	if w1.Code != http.StatusOK && w1.Code != http.StatusNoContent {
		t.Fatalf("CORS preflight for localhost failed: %d", w1.Code)
	}
	if got := w1.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Fatalf("CORS allow-origin = %q, want http://localhost:5173", got)
	}

	// 测试 2：未授权 Origin 不应被允许（CORS 中间件会拒绝，返回 200 但不带 ACAO 头）
	req2 := httptest.NewRequest("OPTIONS", "/api/v1/health", nil)
	req2.Header.Set("Origin", "https://evil.com")
	req2.Header.Set("Access-Control-Request-Method", "GET")
	w2 := httptest.NewRecorder()
	api.Router().ServeHTTP(w2, req2)
	if w2.Header().Get("Access-Control-Allow-Origin") == "https://evil.com" {
		t.Fatal("CORS should not allow evil.com")
	}
}

func TestCORSOriginsEnv(t *testing.T) {
	os.Setenv("CORS_ORIGINS", "https://app.example.com,https://admin.example.com")
	defer os.Unsetenv("CORS_ORIGINS")

	cfg, err := config.Load("")
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.CORSOrigins) != 2 {
		t.Fatalf("CORSOrigins len = %d, want 2", len(cfg.CORSOrigins))
	}
	if cfg.CORSOrigins[0] != "https://app.example.com" {
		t.Fatalf("CORSOrigins[0] = %q", cfg.CORSOrigins[0])
	}
}
