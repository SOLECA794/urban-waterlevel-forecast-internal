// 城市积水智能预测系统 —— Go 后端入口。
// 启动：APP_PORT=8080 ./server（或 go run ./cmd/server）
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

	"waterlog/backend/internal/agent"
	"waterlog/backend/internal/config"
	"waterlog/backend/internal/datasource"
	"waterlog/backend/internal/forecast"
	"waterlog/backend/internal/httpapi"
	"waterlog/backend/internal/scheduler"
	"waterlog/backend/internal/service"
	"waterlog/backend/internal/sim"
	"waterlog/backend/internal/store"
)

func main() {
	cfg, err := config.Load("")
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	st, err := store.Open(cfg.DBPath)
	if err != nil {
		log.Fatalf("open sqlite: %v", err)
	}
	defer st.Close()
	if err := st.Seed(time.Now()); err != nil {
		log.Fatalf("seed: %v", err)
	}

	om := datasource.NewOpenMeteoClient()
	src := datasource.NewSimulatedSource(st, om, cfg.OpenMeteoEnabled, cfg.Datasource.StaleAfterMinutes)

	bus := service.NewBus()
	alerts := service.NewAlertService(cfg.Alert, st, bus)
	orch := agent.NewOrchestrator(cfg.Revision)
	rev := service.NewRevisionService(cfg.Revision)
	fc := service.NewForecastService(cfg, st, alerts, orch, rev, src)
	calib := service.NewCalibrationService(cfg, st)
	pub := service.NewPublishService(st, bus)
	if fixed, err := pub.FixGarbledRecords(); err == nil && fixed > 0 {
		log.Printf("[修复] 已清洗 %d 条乱码发布记录", fixed)
	}

	gen := sim.NewGenerator(st, forecast.BuildParams(&cfg.Forecast, nil, "", 0), cfg.Forecast.StepMinutes)
	sched := scheduler.New(cfg, fc, gen)
	sched.Start()

	api := httpapi.NewAPI(cfg, st, fc, alerts, calib, pub, bus, gen, sched, src)
	srv := &http.Server{Addr: cfg.Addr, Handler: api.Router(), ReadHeaderTimeout: 10 * time.Second}

	go func() {
		log.Printf("[%s] listening on %s (demoMode=%v openMeteo=%v)",
			cfg.App.Name, cfg.Addr, cfg.DemoMode, cfg.OpenMeteoEnabled)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("shutting down ...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	sched.Stop()
	log.Println("bye")
}
