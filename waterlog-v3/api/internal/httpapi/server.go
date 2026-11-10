package httpapi

import (
	"log/slog"

	"waterlog-v3/api/internal/config"
	"waterlog-v3/api/internal/service"
	"waterlog-v3/api/internal/store"
)

// Server 是 HTTP 适配层的根对象。
//
// 它只持有依赖，不持有状态——所有状态都在 service / store 里。
// 这条约束让 handler 天然可以并行、可以被 httptest 直接构造。
type Server struct {
	cfg      config.Config
	svc      *service.Service
	eng      *service.Engine
	store    *store.Store
	auth     *service.Auth
	notifier *service.Notifier
	log      *slog.Logger
	// gw 是 ICM 集成网关的健康快照来源；网关未启用时为 nil。
	gw GatewayHealth
}

// New 装配适配层。cfg 用来读 WebDir（静态托管）与日志级别。
//
// gw 为 nil 表示 ICM 网关未启用——那是一个合法状态，不是装配错误。
func New(
	cfg config.Config,
	svc *service.Service,
	eng *service.Engine,
	st *store.Store,
	a *service.Auth,
	n *service.Notifier,
	log *slog.Logger,
	gw GatewayHealth,
) *Server {
	return &Server{cfg: cfg, svc: svc, eng: eng, store: st, auth: a, notifier: n, log: log, gw: gw}
}
