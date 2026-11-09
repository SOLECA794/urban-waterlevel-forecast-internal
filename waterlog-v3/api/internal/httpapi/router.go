package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"waterlog-v3/api/internal/domain"
)

// Routes 返回完整的 HTTP 路由树（含中间件与静态托管）。
//
// 路由表是这套系统的对外契约，改动要同步 docs/api/openapi.yaml 与前端 data/client.ts。
//
// 鉴权分三段而不是"全站一刀切"：
//
//	公开段   /api/health、/api/auth/*     —— 探活与登录本身不能要求登录
//	只读段   GET 业务接口（含 SSE）        —— 任何已登录角色
//	写入段   确认/派单/规则/模型/演练      —— operator 及以上
//	管理段   账号、审计、推送渠道           —— admin
//
// 把只读接口也挡在登录后面，是因为这套系统里的"只读"数据本身敏感：
// 站点清单 + 阈值 + 积水深度合起来就是一份城市防汛薄弱点地图。
func (s *Server) Routes() http.Handler {
	r := chi.NewRouter()

	// 中间件顺序有讲究：RequestID 先给每个请求一个 ID，后面的访问日志与 panic
	// 日志都靠它把一次请求的多条日志串起来；Recover 必须在业务之前；
	// Audit 要包在 Authenticate 里面，否则它拿不到调用者身份。
	r.Use(RequestID)
	r.Use(s.logRequest)
	r.Use(Recover(s.log))
	r.Use(CORS)
	r.Use(Audit(s.log, s.store))

	r.Route("/api", func(r chi.Router) {
		// ---- 公开：探活与登录
		r.Get("/health", s.health)
		r.Post("/auth/login", s.login)
		r.Post("/auth/logout", s.logout)

		// ---- 引擎 → Go 的写入端（引擎是唯一的数据生产者）
		r.Group(func(r chi.Router) {
			r.Use(RequireIngestToken(s.cfg.IngestToken))
			r.Post("/ingest/telemetry", s.ingestTelemetry)
			r.Post("/ingest/forecast", s.ingestForecast)
		})

		// ---- 已登录即可：读端
		r.Group(func(r chi.Router) {
			r.Use(Authenticate(s.auth))
			r.Get("/auth/me", s.me)
			r.Get("/sites", s.listSites)
			r.Get("/overview", s.overview)
			r.Get("/sites/{id}", s.siteDetail)
			r.Get("/sites/{id}/history", s.siteHistory)
			r.Get("/forecast", s.getForecast)
			r.Get("/alerts", s.listAlerts)
			r.Get("/alerts/{id}", s.alertDetail)
			r.Get("/metrics", s.proxyGet("/metrics"))
			r.Get("/decisions", s.proxyGet("/decisions"))
			r.Get("/eval", s.proxyGet("/eval/pairs"))
			r.Get("/rules", s.proxyGet("/rules"))
			r.Get("/models/versions", s.proxyGet("/models/versions"))
			r.Get("/retrain/status", s.proxyGet("/retrain/status"))
			r.Get("/events", s.events)
		})

		// ---- 值班员及以上：写端
		r.Group(func(r chi.Router) {
			r.Use(Authenticate(s.auth))
			r.Use(RequireRole(domain.RoleOperator))
			r.Post("/alerts/{id}/ack", s.ackAlert)
			r.Post("/alerts/{id}/assign", s.assignAlert)
			r.Post("/alerts/{id}/disposition", s.setDisposition)
			r.Post("/alerts/{id}/notes", s.addAlertNote)
			r.Post("/rules/preview", s.proxyPost("/rules/preview"))
			r.Post("/sim/storm", s.command("/sim/storm"))
			r.Post("/sim/reset-water", s.command("/sim/reset-water"))
		})

		// ---- 管理员：规则落盘、模型切换、重训、账号、审计、推送
		r.Group(func(r chi.Router) {
			r.Use(Authenticate(s.auth))
			r.Use(RequireRole(domain.RoleAdmin))
			r.Put("/rules", s.putRules)
			r.Post("/models/adopt", s.adoptModel)
			r.Post("/retrain", s.command("/retrain"))
			r.Get("/users", s.listUsers)
			r.Post("/users", s.createUser)
			r.Patch("/users/{username}", s.patchUser)
			r.Get("/audit", s.listAudit)
			r.Get("/notify/channels", s.getChannels)
			r.Put("/notify/channels/{name}", s.putChannel)
			r.Get("/notify/deliveries", s.listDeliveries)
			r.Post("/notify/test", s.testChannel)
		})
	})

	s.mountStatic(r)
	return r
}
