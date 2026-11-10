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
	// aiwaterQueue 是 A-6 预测任务的执行队列。
	//
	// 用带缓冲的 channel 而不是无缓冲：无缓冲时提交方会被 worker 的处理速度
	// 拖住，而提交接口的语义是「立刻返回 taskId」，不该等计算。
	// 缓冲满了就返回 503（任务已落库，不会丢），由对方重试。
	aiwaterQueue chan string
}

// aiwaterQueueSize 是预测任务队列的容量。
//
// 32 是个够用的数：对方的提交频率通常是分钟级，
// 而单个任务 300ms 就跑完，队列只在突发峰值时才会积压。
const aiwaterQueueSize = 32

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
	return &Server{
		cfg:          cfg,
		svc:          svc,
		eng:          eng,
		store:        st,
		auth:         a,
		notifier:     n,
		log:          log,
		gw:           gw,
		aiwaterQueue: make(chan string, aiwaterQueueSize),
	}
}
