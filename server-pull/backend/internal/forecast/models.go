// 预测模型统一接口与数据结构（对应 app/domain/ports/forecast_model.py）。
package forecast

import (
	"math"
	"time"

	"waterlog/backend/internal/errs"
)

// Obs 单条时序样本：NaN 表示缺失（对齐 pandas NaN 语义）。
// 未来步的行 Level=NaN、RainForecast 有值；历史步反之。
type Obs struct {
	Ts           time.Time
	Level        float64 // 历史水位（NaN=缺失/未来步）
	RainObserved float64 // 历史实况降雨（NaN=未来步）
	RainForecast float64 // 未来降雨预报（NaN=历史步）
}

// IsNaN 浮点缺失判定。
func IsNaN(v float64) bool { return math.IsNaN(v) }

// NaN 缺失值。
func NaN() float64 { return math.NaN() }

// PointResult 单点预测输出。
type PointResult struct {
	T        time.Time
	LevelRaw float64
	Lower    float64
	Upper    float64
}

// ForecastResult 模型推理输出。
type ForecastResult struct {
	Points             []PointResult
	PeakLevel          float64
	PeakTime           time.Time
	ConfidenceInterval struct {
		Lower float64
		Upper float64
	}
	ModelID     string
	InferenceMS int64
	Notes       []string
}

// ModelMeta 模型元信息。
type ModelMeta struct {
	Name        string
	Version     string
	ModelType   string
	Description string
}

// Model 预测模型统一接口（Port）。
type Model interface {
	Fit(history []Obs)
	SetRecentRMSE(rmse float64, hasRMSE bool)
	Predict(window []Obs, horizonMin int) (*ForecastResult, *errs.BizError)
	Describe() ModelMeta
	ModelType() string
}

// round4 与 Python round(x, 4) 语义对齐（四舍五入到 4 位小数）。
func round4(v float64) float64 { return roundN(v, 4) }

// roundN 十进制四舍五入（Python round 采用银行家舍入，但输出位数 4 位、
// 数值量级 m 级，二进制表示下差异概率可忽略；golden 对拍验证容差 1e-9）。
func roundN(v float64, n int) float64 {
	p := math.Pow(10, float64(n))
	return math.Round(v*p) / p
}

// RoundN roundN 的导出版（agent / service 层复用同一舍入口径）。
func RoundN(v float64, n int) float64 { return roundN(v, n) }

// validLevels 取窗口内有效（非 NaN）历史水位行下标（保持顺序）。
func validLevels(window []Obs) []int {
	idx := make([]int, 0, len(window))
	for i, o := range window {
		if !math.IsNaN(o.Level) {
			idx = append(idx, i)
		}
	}
	return idx
}

// effectiveRain rain = rainForecast.fillna(rainObserved).fillna(0)。
func effectiveRain(window []Obs) []float64 {
	out := make([]float64, len(window))
	for i, o := range window {
		switch {
		case !math.IsNaN(o.RainForecast):
			out[i] = o.RainForecast
		case !math.IsNaN(o.RainObserved):
			out[i] = o.RainObserved
		default:
			out[i] = 0.0
		}
	}
	return out
}

// buildPoints 逐点组装 ForecastPointResult（含 effective_ci 半宽）。
func buildPoints(start time.Time, levels []float64, stepMin int,
	params ModelParams, recentRMSE float64, hasRMSE bool) []PointResult {
	pts := make([]PointResult, len(levels))
	for j, lvl := range levels {
		h := float64((j + 1) * stepMin) / 60.0
		half := EffectiveCI(params.CIBase, recentRMSE, hasRMSE, h, params.CISqrtFactor)
		pts[j] = PointResult{
			T:        start.Add(time.Duration((j + 1) * stepMin) * time.Minute),
			LevelRaw: round4(lvl),
			Lower:    round4(lvl - half),
			Upper:    round4(lvl + half),
		}
	}
	return pts
}

// finalizeResult 求峰值与整体置信区间。
func finalizeResult(pts []PointResult, modelID string, notes []string, inferStart time.Time) *ForecastResult {
	r := &ForecastResult{Points: pts, ModelID: modelID, Notes: notes}
	if len(pts) > 0 {
		peak := pts[0]
		for _, p := range pts[1:] {
			if p.LevelRaw > peak.LevelRaw {
				peak = p
			}
		}
		r.PeakLevel = peak.LevelRaw
		r.PeakTime = peak.T
		r.ConfidenceInterval.Lower = math.Inf(1)
		r.ConfidenceInterval.Upper = math.Inf(-1)
		for _, p := range pts {
			if p.Lower < r.ConfidenceInterval.Lower {
				r.ConfidenceInterval.Lower = p.Lower
			}
			if p.Upper > r.ConfidenceInterval.Upper {
				r.ConfidenceInterval.Upper = p.Upper
			}
		}
	}
	r.InferenceMS = time.Since(inferStart).Milliseconds()
	return r
}

// dataNotEnough 历史数据不足错误（1301）。
func dataNotEnough() *errs.BizError {
	return errs.New(errs.DATA_NOT_ENOUGH, "历史数据不足，无法预测（DATA_NOT_ENOUGH）")
}
