// Package scheduler 周期任务调度：goroutine + time.Ticker（替代 APScheduler）。
// 三个 job：15 分钟滚动预测（含实况回填）、60 秒模拟器 tick、启动 catch-up 自愈。
package scheduler

import (
	"log"
	"sync"
	"time"

	"waterlog/backend/internal/config"
	"waterlog/backend/internal/service"
	"waterlog/backend/internal/sim"
)

// Scheduler 调度器。
type Scheduler struct {
	cfg   *config.Settings
	fc    *service.ForecastService
	gen   *sim.Generator

	stop     chan struct{}
	wg       sync.WaitGroup
	mu       sync.Mutex
	lastRun  time.Time
	lastStat map[string]int
	lastErr  string
	running  bool
}

// New 构造。
func New(cfg *config.Settings, fc *service.ForecastService, gen *sim.Generator) *Scheduler {
	return &Scheduler{cfg: cfg, fc: fc, gen: gen, stop: make(chan struct{})}
}

// Start 启动全部周期任务。首次启动先 catch-up 补齐样本，再立即跑一轮预测。
func (s *Scheduler) Start() {
	s.mu.Lock()
	s.running = true
	s.mu.Unlock()

	// 启动自愈：清空内存态补齐观测样本
	if s.cfg.DemoMode {
		if n := s.gen.CatchUp(time.Now()); n > 0 {
			log.Printf("[scheduler] catch-up 补齐 %d 条观测样本", n)
		}
	}
	if s.cfg.App.AutoForecastOnStartup {
		s.runForecastRound()
	}

	s.wg.Add(1)
	go func() { // 模拟器 tick（60s，仅演示模式）
		defer s.wg.Done()
		if !s.cfg.DemoMode {
			return
		}
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-s.stop:
				return
			case now := <-t.C:
				s.gen.Tick(now)
			}
		}
	}()

	s.wg.Add(1)
	go func() { // 滚动预测（含实况回填；间隔 FORECAST_SCHEDULE_MIN，默认 15 分钟）
		defer s.wg.Done()
		interval := time.Duration(s.cfg.Forecast.ScheduleMinutes) * time.Minute
		if interval <= 0 {
			interval = 15 * time.Minute
		}
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-s.stop:
				return
			case now := <-t.C:
				_ = now
				s.runForecastRound()
			}
		}
	}()
}

func (s *Scheduler) runForecastRound() {
	s.mu.Lock()
	s.running = true
	s.mu.Unlock()
	stat := s.fc.RollingRound(time.Now())
	s.mu.Lock()
	s.lastRun, s.lastStat, s.lastErr, s.running = time.Now(), stat, "", false
	s.mu.Unlock()
	log.Printf("[scheduler] 滚动预测完成：%v", stat)
}

// Stop 停止全部周期任务。
func (s *Scheduler) Stop() {
	close(s.stop)
	s.wg.Wait()
}

// Status 调度器状态快照（/health/detail）。
func (s *Scheduler) Status() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	lastRun := ""
	if !s.lastRun.IsZero() {
		lastRun = s.lastRun.Format(time.RFC3339)
	}
	return map[string]any{
		"running":            s.running,
		"forecastIntervalMin": s.cfg.Forecast.ScheduleMinutes,
		"lastRunAt":          lastRun,
		"lastStat":           s.lastStat,
		"demoMode":           s.cfg.DemoMode,
	}
}
