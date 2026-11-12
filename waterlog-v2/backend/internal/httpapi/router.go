// Package httpapi HTTP 接口层：路由装配 + 统一响应 + SSE 推送 + 前端静态资源。
// 分层对标 new-api：router（路由/中间件）→ controller（本包 handler）→ service（业务）→ repo（数据）。
package httpapi

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"runtime/debug"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"waterlog/v2/internal/config"
	"waterlog/v2/internal/model"
	"waterlog/v2/internal/repo"
	"waterlog/v2/internal/service"
)

// API 全部依赖装配（构造注入，测试可替换）。
type API struct {
	cfg   *config.Settings
	repo  *repo.Repo
	hub   *service.Hub
	tel   *service.TelemetryService
	alarm *service.AlarmService
	rule  *service.RuleEngine
	fc    *service.ForecastService
	sim   *service.Simulator
	startedAt time.Time
}

// Deps 依赖集合。
type Deps struct {
	Cfg   *config.Settings
	Repo  *repo.Repo
	Hub   *service.Hub
	Tel   *service.TelemetryService
	Alarm *service.AlarmService
	Rule  *service.RuleEngine
	FC    *service.ForecastService
	Sim   *service.Simulator
}

func New(d Deps) *API {
	return &API{cfg: d.Cfg, repo: d.Repo, hub: d.Hub, tel: d.Tel, alarm: d.Alarm,
		rule: d.Rule, fc: d.FC, sim: d.Sim, startedAt: time.Now()}
}

// Router 组装路由。
func (a *API) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(recoverJSON)

	origins := a.cfg.CORSOrigins
	if len(origins) == 0 {
		origins = []string{"*"}
	}
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins: origins,
		AllowedMethods: []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders: []string{"Content-Type", "X-Request-Id", "Authorization", "Last-Event-ID"},
		MaxAge:         300,
	}))

	r.Route("/api/v1", func(api chi.Router) {
		api.Get("/system/status", a.handleStatus)
		api.Get("/stream", a.handleStream)

		// 设备画像
		api.Get("/device-profiles", a.handleListProfiles)
		api.Post("/device-profiles", a.handleCreateProfile)
		api.Put("/device-profiles/{id}", a.handleUpdateProfile)
		api.Delete("/device-profiles/{id}", a.handleDeleteProfile)

		// 设备
		api.Get("/devices", a.handleListDevices)
		api.Post("/devices", a.handleCreateDevice)
		api.Get("/devices/{id}", a.handleGetDevice)
		api.Put("/devices/{id}", a.handleUpdateDevice)
		api.Delete("/devices/{id}", a.handleDeleteDevice)
		api.Get("/devices/{id}/telemetry", a.handleTelemetry)
		api.Get("/devices/{id}/latest", a.handleLatest)
		api.Get("/devices/{id}/forecast", a.handleForecast)

		// 遥测上报（真实设备与模拟器共用）
		api.Get("/telemetry/latest", a.handleLatestAll)
		api.Post("/telemetry", a.handleIngest)

		// 规则链
		api.Get("/rule-chains", a.handleListChains)
		api.Post("/rule-chains", a.handleCreateChain)
		api.Get("/rule-chains/{id}", a.handleGetChain)
		api.Put("/rule-chains/{id}", a.handleUpdateChain)
		api.Delete("/rule-chains/{id}", a.handleDeleteChain)
		api.Post("/rule-chains/{id}/nodes", a.handleCreateNode)
		api.Put("/rule-nodes/{nodeId}", a.handleUpdateNode)
		api.Delete("/rule-nodes/{nodeId}", a.handleDeleteNode)

		// 告警
		api.Get("/alert-levels", a.handleAlertLevels)

		api.Get("/alarms", a.handleListAlarms)
		api.Get("/alarms/stats", a.handleAlarmStats)
		api.Get("/alarms/{id}", a.handleGetAlarm)
		api.Post("/alarms/{id}/ack", a.handleAck)
		api.Post("/alarms/{id}/clear", a.handleClear)
		api.Post("/alarms/{id}/false-report", a.handleFalseReport)

		// 大屏
		api.Get("/dashboard", a.handleGetDashboard)
		api.Put("/dashboard/{id}", a.handleUpdateDashboard)

		// 演示：注入降雨
		api.Post("/sim/rain", a.handleInjectRain)
	})

	// 前端静态资源（embed，SPA fallback）
	r.NotFound(a.serveSPA)
	return r
}

// ---------- 统一响应 ----------

const codeOK = 0

type respBody struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data"`
}

func writeOK(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(respBody{Code: codeOK, Message: "ok", Data: data})
}

// apiError 业务错误：携带 HTTP 状态与业务码。
type apiError struct {
	Status int
	Code   int
	Msg    string
}

func (e *apiError) Error() string { return e.Msg }

func badRequest(msg string) error { return &apiError{Status: http.StatusBadRequest, Code: 400, Msg: msg} }
func notFound(msg string) error   { return &apiError{Status: http.StatusNotFound, Code: 404, Msg: msg} }
func conflict(msg string) error   { return &apiError{Status: http.StatusConflict, Code: 409, Msg: msg} }

func writeErr(w http.ResponseWriter, err error) {
	var ae *apiError
	if errors.As(err, &ae) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(ae.Status)
		_ = json.NewEncoder(w).Encode(respBody{Code: ae.Code, Message: ae.Msg})
		return
	}
	log.Printf("[http] 内部错误: %v", err)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusInternalServerError)
	_ = json.NewEncoder(w).Encode(respBody{Code: 500, Message: "internal error"})
}

func recoverJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[panic] %v\n%s", rec, debug.Stack())
				w.WriteHeader(http.StatusInternalServerError)
				_ = json.NewEncoder(w).Encode(respBody{Code: 500, Message: "internal panic"})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// ---------- 参数解析 ----------

func pathID(r *http.Request, key string) (int64, error) {
	v, err := strconv.ParseInt(chi.URLParam(r, key), 10, 64)
	if err != nil || v <= 0 {
		return 0, badRequest("路径参数非法")
	}
	return v, nil
}

func queryInt(r *http.Request, key string, def int) int {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func queryInt64(r *http.Request, key string, def int64) int64 {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

func decodeBody(r *http.Request, v any) error {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		return badRequest("请求体解析失败: " + err.Error())
	}
	return nil
}

// ---------- SSE ----------

func (a *API) handleStream(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, &apiError{Status: 500, Code: 500, Msg: "streaming unsupported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // nginx 反代禁用缓冲
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(": connected\n\n"))
	fl.Flush()

	ch, cancel := a.hub.Subscribe()
	defer cancel()
	ka := time.NewTicker(20 * time.Second)
	defer ka.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ka.C:
			if _, err := w.Write([]byte(": keepalive\n\n")); err != nil {
				return
			}
			fl.Flush()
		case msg := <-ch:
			if _, err := w.Write([]byte("data: " + string(msg) + "\n\n")); err != nil {
				return
			}
			fl.Flush()
		}
	}
}

// ---------- 状态 ----------

type statusDTO struct {
	App          string `json:"app"`
	Version      string `json:"version"`
	DemoMode     bool   `json:"demoMode"`
	UptimeSec    int64  `json:"uptimeSec"`
	ServerTs     int64  `json:"serverTs"`
	Subscribers  int    `json:"subscribers"`
	Raining      bool   `json:"raining"`
	RainPower    float64 `json:"rainPower"`
}

func (a *API) handleStatus(w http.ResponseWriter, r *http.Request) {
	raining, power := a.sim.RainState()
	writeOK(w, statusDTO{
		App: a.cfg.AppName, Version: "v2.0.0", DemoMode: a.cfg.DemoMode,
		UptimeSec: int64(time.Since(a.startedAt).Seconds()), ServerTs: time.Now().Unix(),
		Subscribers: a.hub.Subscribers(), Raining: raining, RainPower: power,
	})
}

func (a *API) handleInjectRain(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Power       float64 `json:"power"`
		DurationSec int64   `json:"durationSec"`
	}
	_ = decodeBody(r, &body)
	a.sim.InjectRain(body.Power, body.DurationSec)
	raining, power := a.sim.RainState()
	writeOK(w, map[string]any{"raining": raining, "power": power})
}

// 供 handlers 复用
var _ = model.DeviceOnline
