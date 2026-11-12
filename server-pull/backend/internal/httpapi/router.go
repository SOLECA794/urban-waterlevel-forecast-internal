// chi 路由装配 + 中间件 + 统一响应。
package httpapi

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"runtime/debug"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"waterlog/backend/internal/config"
	"waterlog/backend/internal/datasource"
	"waterlog/backend/internal/errs"
	"waterlog/backend/internal/scheduler"
	"waterlog/backend/internal/service"
	"waterlog/backend/internal/sim"
	"waterlog/backend/internal/store"
)

// API 全部依赖装配。
type API struct {
	cfg   *config.Settings
	store *store.Store
	fc    *service.ForecastService
	alert *service.AlertService
	calib *service.CalibrationService
	pub   *service.PublishService
	bus   *service.Bus
	gen   *sim.Generator
	sched *scheduler.Scheduler
	src   *datasource.SimulatedSource
}

// NewAPI 构造。
func NewAPI(cfg *config.Settings, st *store.Store, fc *service.ForecastService,
	alert *service.AlertService, calib *service.CalibrationService, pub *service.PublishService,
	bus *service.Bus, gen *sim.Generator, sched *scheduler.Scheduler,
	src *datasource.SimulatedSource) *API {
	return &API{cfg: cfg, store: st, fc: fc, alert: alert, calib: calib, pub: pub,
		bus: bus, gen: gen, sched: sched, src: src}
}

// Router 组装全部路由。
func (a *API) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID) // X-Trace-Id 生成与透传
	r.Use(middleware.RealIP)
	r.Use(recoverJSON) // panic recovery → 500 JSON
	// CORS：默认只允许同源（nginx 反代场景无需跨域）；部署时通过 CORS_ORIGINS 配置白名单
	corsOrigins := a.cfg.CORSOrigins
	if len(corsOrigins) == 0 {
		corsOrigins = []string{"http://localhost", "http://localhost:5173", "http://127.0.0.1"}
	}
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   corsOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		AllowCredentials: true,
	}))

	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/system/status", a.systemStatus)

		r.Get("/alert-levels", a.getAlertLevels)
		r.Put("/alert-levels", a.putAlertLevels)
		r.Get("/forecast/leads", a.getLeads)
		r.Put("/forecast/leads", a.putLeads)

		r.Get("/stations", a.listStations)
		r.Post("/stations", a.createStation)
		r.Get("/stations/{id}", a.getStation)
		r.Put("/stations/{id}", a.updateStation)
		r.Delete("/stations/{id}", a.deleteStation)
		r.Get("/stations/{id}/series", a.stationSeries)
		r.Get("/stations/{id}/forecasts", a.stationForecasts)
		r.Post("/stations/{id}/predict", a.stationPredict)

		r.Get("/forecasts/{id}/comparison", a.forecastComparison)
		r.Get("/forecasts/{id}/decision", a.forecastDecision)

		r.Get("/alerts", a.listAlerts)
		r.Get("/alerts/stats", a.alertStats)
		r.Post("/alerts/{id}/confirm", a.alertConfirm)
		r.Post("/alerts/{id}/resolve", a.alertResolve)
		r.Post("/alerts/{id}/false-report", a.alertFalseReport)
		r.Post("/alerts/{id}/publish", a.alertPublish)
		r.Get("/alerts/publish-records", a.publishRecords)

		r.Get("/datasources", a.listDatasources)
		r.Put("/datasources/{id}", a.updateDatasource)

		r.Get("/publish-channels", a.getChannels)
		r.Put("/publish-channels", a.putChannels)

		r.Get("/calibrations", a.listCalibrations)
		r.Post("/calibrations", a.createCalibration)
		r.Get("/models", a.listModels)
		r.Post("/models/{id}/activate", a.activateModel)
		r.Post("/calibrate-params", a.calibrateParams)

		r.Get("/health", a.health)
		r.Get("/health/detail", a.healthDetail)
		r.Get("/stream/alerts", a.streamAlerts)

		r.Post("/sim/events", a.injectEvent)
		r.Get("/sim/events", a.listEvents)
	})
	return r
}

// ---------- 统一响应 ----------

type respBody struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data"`
}

func writeOK(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(respBody{Code: int(errs.OK), Message: "ok", Data: data})
}

func writeErr(w http.ResponseWriter, err error) {
	if err == nil {
		err = errors.New("unknown error")
	}
	var be *errs.BizError
	if errors.As(err, &be) && be != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusOK) // HTTP 200 + 业务 code 模式（沿用原后端）
		_ = json.NewEncoder(w).Encode(respBody{Code: int(be.Code), Message: be.Message, Data: be.Data})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusInternalServerError)
	_ = json.NewEncoder(w).Encode(respBody{Code: int(errs.INTERNAL_ERROR), Message: err.Error(), Data: nil})
}

func recoverJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[panic] %v\n%s", rec, debug.Stack())
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.WriteHeader(http.StatusInternalServerError)
				_ = json.NewEncoder(w).Encode(respBody{Code: int(errs.INTERNAL_ERROR),
					Message: "internal panic", Data: nil})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// ---------- 请求解析 ----------

func pathID(r *http.Request) (int64, error) {
	v, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		return 0, errs.New(errs.PARAM_INVALID, "路径参数 id 非法（PARAM_INVALID）")
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

func queryStr(r *http.Request, key string) *string {
	if v := r.URL.Query().Get(key); v != "" {
		return &v
	}
	return nil
}

func decodeBody(r *http.Request, v any) error {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		return errs.New(errs.PARAM_INVALID, "请求体解析失败（PARAM_INVALID）")
	}
	return nil
}
