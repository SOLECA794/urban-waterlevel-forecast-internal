// 模拟数据源：observation 表实况 + future_truth 降雨真值 → 按需生成降雨预报序列。
// 移植自 app/infrastructure/datasource/simulated_source.py（ε(h) 误差模型逐行对齐）。
package datasource

import (
	"math"
	"sync"
	"time"

	"waterlog/backend/internal/forecast"
	"waterlog/backend/internal/rng"
	"waterlog/backend/internal/store"
)

// SimulatedSource 模拟数据源。
type SimulatedSource struct {
	mu          sync.Mutex
	store       *store.Store
	openmeteo   *OpenMeteoClient
	omEnabled   bool
	staleAfter  float64
	linkStatus  string // STREAMING / DISCONNECTED / ERROR
	lastErr     string
}

// NewSimulatedSource 构造（linkStatus 初始 STREAMING，由调度器 tick 维持）。
func NewSimulatedSource(st *store.Store, om *OpenMeteoClient, omEnabled bool, staleAfterMinutes float64) *SimulatedSource {
	return &SimulatedSource{
		store: st, openmeteo: om, omEnabled: omEnabled,
		staleAfter: staleAfterMinutes, linkStatus: "STREAMING",
	}
}

// SetLinkStatus 供健康检查/调度器更新链路状态。
func (s *SimulatedSource) SetLinkStatus(status, detail string) {
	s.mu.Lock()
	s.linkStatus, s.lastErr = status, detail
	s.mu.Unlock()
}

// EvaluateSourceStatus 纯函数：链路状态 + 数据新鲜度 → 对外状态（可单测）。
// 移植 evaluate_source_status：链路异常优先；链路正常但样本滞后 > 阈值 → STALE。
func EvaluateSourceStatus(linkStatus string, dataAgeMin *float64, staleAfterMinutes float64) (string, string) {
	if linkStatus == "ERROR" || linkStatus == "DISCONNECTED" {
		return linkStatus, "数据源链路异常（FR-1.3）"
	}
	if dataAgeMin == nil {
		return linkStatus, "暂无样本（等待首次采集）"
	}
	if *dataAgeMin > staleAfterMinutes {
		return "STALE", "观测数据滞后（超过阈值，生成器可能停滞）"
	}
	if linkStatus == "" {
		linkStatus = "READY"
	}
	return linkStatus, "模拟数据源运行正常"
}

// StatusValue 数据源对外状态（供质量评估与编排 D5 消费）。
func (s *SimulatedSource) StatusValue(dataAgeMin *float64) string {
	s.mu.Lock()
	link, lastErr := s.linkStatus, s.lastErr
	s.mu.Unlock()
	st, _ := EvaluateSourceStatus(link, dataAgeMin, s.staleAfter)
	_ = lastErr
	return st
}

// Detail 状态说明 + 新鲜度（健康检查 payload）。
func (s *SimulatedSource) Detail(dataAgeMin *float64) (status, detail string) {
	s.mu.Lock()
	link, lastErr := s.linkStatus, s.lastErr
	s.mu.Unlock()
	st, d := EvaluateSourceStatus(link, dataAgeMin, s.staleAfter)
	if lastErr != "" {
		d = lastErr
	}
	return st, d
}

// GetRainForecast 产出 [tIssue, tIssue+hours] 的逐步降雨预报（mm/step）。
// 优先 Open-Meteo 真实预报；失败降级到「未来真值 × 误差因子」模拟：
// ε(h) ~ N(-0.10·h_norm, 0.12+0.38·h_norm)，factor=clip(1+ε,0,1.6)，峰值(>5mm)再×0.8。
func (s *SimulatedSource) GetRainForecast(stationID int64, tIssue time.Time, hours, stepMinutes int,
	lat, lon float64) []RainPoint {
	if s.omEnabled && s.openmeteo != nil {
		if pts, err := s.openmeteo.GetRealRainForecast(tIssue, hours, stepMinutes, lat, lon); err == nil && len(pts) > 0 {
			return pts
		}
	}
	truth, err := s.store.FutureTruth(stationID)
	if err != nil {
		truth = map[int64]float64{}
	}
	n := hours * 60 / stepMinutes
	seed := uint64(abs64(tIssue.Unix()*1000 + stationID) % (1 << 32))
	r := rng.New(seed)
	out := make([]RainPoint, 0, n)
	for k := 0; k < n; k++ {
		ts := tIssue.Add(time.Duration(k*stepMinutes) * time.Minute)
		trueVal := truth[ts.Unix()/60*60] // future_truth 以分钟对齐写入
		// ε(h)：偏差与波动随预见期单调增大
		var hNorm float64
		if n > 1 {
			hNorm = float64(k) / float64(n-1)
		}
		bias := -0.10 * hNorm
		sigma := 0.12 + 0.38*hNorm
		eps := r.Normal(bias, sigma)
		factor := 1.0 + eps
		factor = math.Max(0.0, math.Min(1.6, factor))
		// 峰值额外低估：对超过 5mm 的时步再打 0.8 折（强对流典型缺陷）
		if trueVal > 5.0 {
			factor *= 0.8
		}
		out = append(out, RainPoint{Ts: ts, RainForecast: roundTo(trueVal*factor, 2)})
	}
	return out
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

var _ = forecast.NaN // 保持 forecast 包引用（NaN 语义说明见 models.go）
