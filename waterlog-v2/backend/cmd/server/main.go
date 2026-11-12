// 城市内涝监测预警平台 v2 —— Go 后端入口。
//
// 启动：ADDR=:8101 DB_PATH=data/v2.db ./waterlog-v2
// 架构分层：httpapi(router/controller) → service(业务) → repo(数据) → db(SQLite)
// 领域范式参考 ThingsBoard CE（Apache 2.0）：设备画像/遥测/规则链/告警四态生命周期。
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"waterlog/v2/internal/config"
	"waterlog/v2/internal/db"
	"waterlog/v2/internal/httpapi"
	"waterlog/v2/internal/repo"
	"waterlog/v2/internal/service"
)

func main() {
	cfg := config.Load()

	database, err := db.Open(cfg.DBPath)
	if err != nil {
		log.Fatalf("打开数据库失败: %v", err)
	}
	defer database.Close()

	r := repo.New(database)
	if err := service.Seed(r); err != nil {
		log.Fatalf("初始化演示数据失败: %v", err)
	}

	hub := service.NewHub()
	alarm := service.NewAlarmService(r, hub, cfg.AlarmCooldownSec)
	rule := service.NewRuleEngine(r, alarm)
	tel := service.NewTelemetryService(r, hub)
	tel.AttachRuleEngine(rule)
	fc := service.NewForecastService(r)
	sim := service.NewSimulator(r, tel, cfg.SimIntervalSec)

	stop := make(chan struct{})
	if cfg.DemoMode {
		sim.Start(stop)
		log.Printf("[sim] 模拟数据源已启动，间隔 %ds", cfg.SimIntervalSec)
	} else {
		log.Printf("[sim] DEMO_MODE=false：未启动模拟数据源，等待真实设备通过 POST /api/v1/telemetry 上报")
	}
	go rule.StartJanitor(stop)
	go housekeeping(r, stop, cfg.RetentionHours)

	api := httpapi.New(httpapi.Deps{
		Cfg: cfg, Repo: r, Hub: hub, Tel: tel, Alarm: alarm, Rule: rule, FC: fc, Sim: sim,
	})

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.Router(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Printf("[%s] listening on %s (demoMode=%v)", cfg.AppName, cfg.Addr, cfg.DemoMode)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("HTTP 服务失败: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("收到退出信号，优雅关闭…")
	close(stop)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

// housekeeping 周期任务：设备离线标记 + 遥测保留窗口清理。
func housekeeping(r *repo.Repo, stop <-chan struct{}, retentionHours int) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			now := time.Now().Unix()
			// 60 秒无上报 → stale（演示节奏 5s，留足冗余）
			if err := r.MarkStaleDevices(now - 60); err != nil {
				log.Printf("[housekeeping] 标记离线失败: %v", err)
			}
			// 每小时最多清理一次过期遥测
			if now%3600 < 30 {
				if err := r.PurgeOlderThan(now - int64(retentionHours)*3600); err != nil {
					log.Printf("[housekeeping] 清理过期遥测失败: %v", err)
				}
			}
		case <-stop:
			return
		}
	}
}
