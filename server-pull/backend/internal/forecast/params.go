// Package forecast 预测内核：参数、核函数与置信区间公式。
// 移植自 app/infrastructure/forecast/params.py（43 行，直接移植，公式逐行对齐）。
package forecast

import "math"

// BuildKernel 汇流滞后核：Gamma 形响应，ΣW=1，i=1..kernelLen。
func BuildKernel(kernelLen int, tau float64) []float64 {
	w := make([]float64, kernelLen)
	sum := 0.0
	for i := 1; i <= kernelLen; i++ {
		v := float64(i) * math.Exp(-float64(i)/tau)
		w[i-1] = v
		sum += v
	}
	for i := range w {
		w[i] /= sum
	}
	return w
}

// ModelParams 模型运行参数（站点可覆盖 responseK/baseLevel；标定可覆盖全部）。
// 与原 ModelParams dataclass 字段一一对应；stationOverrides 仅作占位说明字段（Go 版覆盖逻辑在 registry.BuildParams）。
type ModelParams struct {
	BaseLevel     float64 `json:"baseLevel"`
	ResponseK     float64 `json:"responseK"`
	Gain          float64 `json:"gain"`
	KernelLen     int     `json:"kernelLen"`
	KernelTau     float64 `json:"kernelTau"`
	Decay         float64 `json:"decay"`
	CIBase        float64 `json:"ciBase"`
	CISqrtFactor  float64 `json:"ciSqrtFactor"`
}

// DefaultModelParams 与原 dataclass 默认值一致。
func DefaultModelParams() ModelParams {
	return ModelParams{
		BaseLevel:    1.0,
		ResponseK:    0.010,
		Gain:         0.004,
		KernelLen:    12,
		KernelTau:    5.0,
		Decay:        0.08,
		CIBase:       0.02,
		CISqrtFactor: 0.06,
	}
}

// Kernel 返回汇流滞后核。
func (p ModelParams) Kernel() []float64 {
	return BuildKernel(p.KernelLen, p.KernelTau)
}

// EffectiveCI D4 置信区间自适应：宽度 ∝ 近期RMSE × √h（无误差记录时用基础宽度）。
// rmse<=0 或 nil 时走基础宽度分支。hasRMSE 表达原 Optional[float] 的 None 语义。
func EffectiveCI(halfWidthBase float64, rmse float64, hasRMSE bool, hHours float64, ciSqrtFactor float64) float64 {
	hh := math.Max(hHours, 0.25)
	if hasRMSE && rmse > 0 {
		return math.Max(0.01, rmse*math.Sqrt(hh)*ciSqrtFactor*6.0)
	}
	return halfWidthBase * (1.0 + 0.9*math.Sqrt(hh))
}
