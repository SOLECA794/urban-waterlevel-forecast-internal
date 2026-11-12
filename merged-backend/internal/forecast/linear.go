// LinearResponseModel 降雨线性响应模型。
// Δlevel(t+h) = gain·Σwᵢ·rain(t+j−i) − k·(level − base)。
// 移植自 app/infrastructure/forecast/linear_response.py（递推与核卷积逐行对齐）。
package forecast

import (
	"time"

	"waterlog/backend/internal/errs"
)

type LinearResponseModel struct {
	params     ModelParams
	recentRMSE float64
	hasRMSE    bool
}

// NewLinearResponseModel 构造线性响应模型。
func NewLinearResponseModel(p ModelParams) *LinearResponseModel {
	return &LinearResponseModel{params: p}
}

// Fit 线性响应模型参数由配置/标定给出，fit 保留为接口一致性。
func (m *LinearResponseModel) Fit(history []Obs) {}

// SetRecentRMSE 注入近期误差。
func (m *LinearResponseModel) SetRecentRMSE(rmse float64, has bool) { m.recentRMSE, m.hasRMSE = rmse, has }

// ModelType 模型类型标识。
func (m *LinearResponseModel) ModelType() string { return "linear_response" }

// Predict 线性响应递推预测。
func (m *LinearResponseModel) Predict(window []Obs, horizonMin int) (*ForecastResult, *errs.BizError) {
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
	kernel := m.params.Kernel()
	kLen := len(kernel)
	gain := m.params.Gain
	kRec := m.params.ResponseK
	base := m.params.BaseLevel

	// 有效降雨输入：未来步取降雨预报，历史步取实况
	rain := EffectiveRain(window)

	last := window[valid[len(valid)-1]]
	levelNow := last.Level
	histLen := len(valid) // 历史步数（与 rain 前段对齐）
	startTs := last.Ts

	levels := make([]float64, 0, nSteps)
	lvl := levelNow
	for j := 1; j <= nSteps; j++ {
		idx := histLen - 1 + j // t+j 时刻在 rain 数组中的下标
		lo := idx - kLen + 1
		segLo := lo
		if segLo < 0 {
			segLo = 0
		}
		if segLo > idx+1 {
			segLo = idx + 1
		}
		seg := append([]float64{}, rain[segLo:idx+1]...)
		if len(seg) > kLen {
			seg = seg[len(seg)-kLen:]
		}
		if len(seg) < kLen { // 左补零
			padded := make([]float64, kLen)
			copy(padded[kLen-len(seg):], seg)
			seg = padded
		}
		dot := 0.0
		for i := 0; i < kLen; i++ {
			dot += kernel[i] * seg[i]
		}
		inflow := gain * dot
		lvl = lvl + inflow - kRec*(lvl-base)
		if lvl < 0 {
			lvl = 0
		}
		levels = append(levels, lvl)
	}

	pts := buildPoints(startTs, levels, stepMin, m.params, m.recentRMSE, m.hasRMSE)
	return finalizeResult(pts, "linear_response:v1.0",
		[]string{"降雨线性响应：Σwᵢ·rain(t−i) 驱动上涨，k·(level−base) 退水（占位实现）"}, t0), nil
}

// Describe 模型元信息。
func (m *LinearResponseModel) Describe() ModelMeta {
	return ModelMeta{Name: "LinearResponseModel", Version: "v1.0", ModelType: "linear_response",
		Description: "降雨线性响应占位模型：降雨驱动 + 汇流滞后 + 退水"}
}
