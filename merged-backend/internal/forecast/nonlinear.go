// NonlinearRunoffModel 非线性汇流时序模型。
// tanh 饱和产流 + 指数退水 + (gain,k,sat) 三维网格自学习。
// 移植自 app/infrastructure/forecast/nonlinear_model.py。
package forecast

import (
	"fmt"
	"math"
	"time"

	"waterlog/backend/internal/errs"
)

type NonlinearRunoffModel struct {
	params     ModelParams
	recentRMSE float64
	hasRMSE    bool
	gain       float64
	kRec       float64
	sat        float64
}

// NewNonlinearRunoffModel 构造非线性汇流模型。
func NewNonlinearRunoffModel(p ModelParams) *NonlinearRunoffModel {
	return &NonlinearRunoffModel{params: p, gain: p.Gain, kRec: p.ResponseK, sat: 8.0}
}

// SetRecentRMSE 注入近期误差。
func (m *NonlinearRunoffModel) SetRecentRMSE(rmse float64, has bool) { m.recentRMSE, m.hasRMSE = rmse, has }

// ModelType 模型类型标识。
func (m *NonlinearRunoffModel) ModelType() string { return "nonlinear" }

// step 单步递推：inflow = gain·tanh(rain/sat)·sat；outflow = k·(level−base)。
func nonlinearStep(level, rainInflow, base, k, gain, sat float64) float64 {
	inflow := gain * math.Tanh(rainInflow/sat) * sat
	outflow := k * (level - base)
	nxt := level + inflow - outflow
	if nxt < 0 {
		return 0.0
	}
	return nxt
}

// Fit 网格搜索自学习 (g,k,sat)：g×k×s = 5×4×3 = 90 组合，最小化模拟 RMSE。
// 历史不足 24 行直接返回（与原实现一致）。
func (m *NonlinearRunoffModel) Fit(history []Obs) {
	var levels, rain []float64
	for _, o := range history {
		if !math.IsNaN(o.Level) {
			levels = append(levels, o.Level)
			r := 0.0
			if !math.IsNaN(o.RainObserved) {
				r = o.RainObserved
			}
			rain = append(rain, r)
		}
	}
	base := m.params.BaseLevel
	if len(levels) < 24 || len(rain) < 24 {
		return
	}
	bestRMSE := math.Inf(1)
	best := [3]float64{m.gain, m.kRec, m.sat}
	for _, g := range []float64{0.02, 0.04, 0.06, 0.08, 0.12} {
		for _, k := range []float64{0.01, 0.02, 0.03, 0.05} {
			for _, s := range []float64{4.0, 8.0, 15.0} {
				var sqSum float64
				lv := levels[0]
				for i := 1; i < len(levels); i++ {
					lv = nonlinearStep(lv, rain[i], base, k, g, s)
					d := lv - levels[i]
					sqSum += d * d
				}
				rmse := math.Sqrt(sqSum / float64(len(levels)-1))
				if rmse < bestRMSE {
					bestRMSE = rmse
					best = [3]float64{g, k, s}
				}
			}
		}
	}
	m.gain, m.kRec, m.sat = best[0], best[1], best[2]
}

// FittedParams 返回自学习后的参数（供测试与决策记录）。
func (m *NonlinearRunoffModel) FittedParams() (gain, k, sat float64) {
	return m.gain, m.kRec, m.sat
}

// Predict 非线性汇流预测（未来步雨量取 rain_all[idx]，越界取 0）。
func (m *NonlinearRunoffModel) Predict(window []Obs, horizonMin int) (*ForecastResult, *errs.BizError) {
	t0 := time.Now()
	valid := ValidLevels(window)
	if len(valid) == 0 {
		return nil, dataNotEnough()
	}
	stepMin := 5
	nSteps := horizonMin / stepMin
	if nSteps < 1 {
		nSteps = 1
	}
	rainAll := EffectiveRain(window)
	last := window[valid[len(valid)-1]]
	levelNow := last.Level
	histLen := len(valid)
	startTs := last.Ts

	levels := make([]float64, 0, nSteps)
	lvl := levelNow
	for j := 1; j <= nSteps; j++ {
		idx := histLen - 1 + j
		rainStep := 0.0
		if idx < len(rainAll) {
			rainStep = rainAll[idx]
		}
		lvl = nonlinearStep(lvl, rainStep, m.params.BaseLevel, m.kRec, m.gain, m.sat)
		levels = append(levels, lvl)
	}
	pts := buildPoints(startTs, levels, stepMin, m.params, m.recentRMSE, m.hasRMSE)
	note := fmt.Sprintf("非线性汇流模型：gain=%.3f k=%.3f sat=%.1f；特征=水位差+多窗口累计降雨+雨势斜率",
		m.gain, m.kRec, m.sat)
	return finalizeResult(pts, "nonlinear:v1.0", []string{note}, t0), nil
}

// Describe 模型元信息。
func (m *NonlinearRunoffModel) Describe() ModelMeta {
	return ModelMeta{Name: "NonlinearRunoffModel", Version: "v1.0", ModelType: "nonlinear",
		Description: "非线性汇流时序模型：多窗口特征工程+tanh饱和产流+指数退水+参数自学习"}
}
