// Command waterlog-api 是 waterlog-v3 的 HTTP API 进程。
//
// 它只做装配：读配置 → 开库 → 连引擎 → 挂路由 → 监听 → 等信号退出。
// 业务在 internal/service，存储细节在 internal/store，HTTP 细节在 internal/httpapi。
//
// 之所以单独一个 cmd 目录而不是平铺在 api/ 根下：
// 平铺时 main 包会与所有 handler 挤在同一命名空间，任何 handler 都能随手
// 摸到全局变量；分层后 main 只剩一条装配线，加一个 handler 不可能顺手改坏启动流程。
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"waterlog-v3/api/internal/config"
	"waterlog-v3/api/internal/httpapi"
	"waterlog-v3/api/internal/platform/logx"
	"waterlog-v3/api/internal/service"
	"waterlog-v3/api/internal/store"
)

// version 由构建脚本注入（-ldflags "-X main.version=..."），默认 dev。
var version = "dev"

func main() {
	healthcheck := flag.Bool("healthcheck", false, "探活模式：请求本机 /api/health，健康则退出码 0（供容器 healthcheck 使用）")
	flag.Parse()

	cfg := config.Load()
	log := logx.New(cfg.LogFormat)

	if *healthcheck {
		os.Exit(runHealthcheck(cfg))
	}

	if err := cfg.Validate(); err != nil {
		log.Error("配置非法", "err", err)
		os.Exit(1)
	}
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		log.Error("创建数据目录失败", "dir", cfg.DataDir, "err", err)
		os.Exit(1)
	}

	st, err := store.OpenStore(cfg.DBPath)
	if err != nil {
		log.Error("打开数据库失败", "path", cfg.DBPath, "err", err)
		os.Exit(1)
	}
	defer func() { _ = st.Close() }()

	eng := service.NewEngine(cfg.EngineURL)
	svc := service.New(st, eng, service.NewHub())

	auth := service.NewAuth(st, time.Duration(cfg.SessionTTLH)*time.Hour, cfg.BootstrapAdminPassword)
	notifier := service.NewNotifier(st, log)
	svc.SetNotifier(notifier)

	// 站点清单以 Python 侧为唯一事实来源，拉不到就用内置副本。
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	svc.LoadSites(ctx)
	cancel()
	// 启动时把已有预测快照读回来，避免前端刷新看到空白
	svc.RestoreForecast()

	// 空库时创建引导管理员。口令只在"刚刚创建"时才打印一次——
	// 它不该出现在每一条启动日志里。
	if pwd, created, err := auth.EnsureBootstrap(svc.NowTS()); err != nil {
		log.Error("初始化引导账号失败", "err", err)
	} else if created {
		log.Warn("已创建引导管理员，请立即修改口令",
			"username", "admin", "password", pwd,
			"env", "WL_BOOTSTRAP_ADMIN_PASSWORD")
	}
	notifier.EnsureChannels(svc.NowTS())

	log.Info("启动完成",
		"version", version,
		"sites", len(svc.Sites()),
		"engine", cfg.EngineURL,
		"db", cfg.DBPath,
		"web", cfg.WebDir,
		"session_ttl_h", cfg.SessionTTLH,
	)

	// 后台清理：遥测/决策/快照只保留 PruneKeepHours 小时。
	bgCtx, bgCancel := context.WithCancel(context.Background())
	defer bgCancel()
	go svc.StartPrune(bgCtx, cfg.PruneKeepHours, 5*time.Minute)

	api := httpapi.New(cfg, svc, eng, st, auth, notifier, log)
	srv := &http.Server{
		Addr:              fmt.Sprintf("%s:%d", cfg.Host, cfg.Port),
		Handler:           api.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
		// 不设 WriteTimeout：SSE 是长连接，写超时会把推送流掐断
	}

	// 优雅退出：收到 SIGINT/SIGTERM 后停止接新连接，给在途请求 10 秒。
	idle := make(chan struct{})
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		<-sig
		log.Info("收到退出信号，开始优雅关闭")
		shutCtx, shutCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutCancel()
		if err := srv.Shutdown(shutCtx); err != nil {
			log.Error("优雅关闭失败", "err", err)
		}
		close(idle)
	}()

	log.Info("HTTP 监听中", "addr", srv.Addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("监听失败", "addr", srv.Addr, "err", err)
		os.Exit(1)
	}
	<-idle
	log.Info("已退出")
}

// runHealthcheck 供容器 healthcheck 使用：容器里没有 curl，二进制自带最省事。
//
// 注意这里请求的是 /api/health，它在公开段——容器探活时没有会话 cookie，
// 如果探活要鉴权，容器会被自己判成不健康。
func runHealthcheck(cfg config.Config) int {
	url := fmt.Sprintf("http://127.0.0.1:%d/api/health", cfg.Port)
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck:", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "healthcheck: status %d\n", resp.StatusCode)
		return 1
	}
	return 0
}
