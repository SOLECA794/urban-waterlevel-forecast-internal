// NaiveModel 持久性模型：level(t+h) = level(t) + (base−level(t))·decay·h。
// 移植自 app/infrastructure/forecast/naive_model.py。
package forecast

import (
	"time"

	"waterlog/backend/internal/errs"
)

type NaiveModel struct {
	params    ModelParams
	recentRMSE float64
	hasRMSE   bool
}

// NewNaiveModel 构造持久性模型。
func NewNaiveModel(p ModelParams) *NaiveModel { return &NaiveModel{params: p} }

// Fit 持久性模型无训练过程（接口一致性保留）。
func (m *NaiveModel) Fit(history []Obs) {}

// SetRecentRMSE 注入近期误差。
func (m *NaiveModel) SetRecentRMSE(rmse float64, has bool) { m.recentRMSE, m.hasRMSE = rmse, has }

// ModelType 模型类型标识。
func (m *NaiveModel) ModelType() string { return "naive" }

// Predict 持续性预测。
func (m *NaiveModel) Predict(window []Obs, horizonMin int) (*ForecastResult, *errs.BizError) {
	t0 := time.Now()
	valid := validLevels(window)
	if len(valid) == 0 {
		return nil, dataNotEnough()
	}
	stepMin := 5
	nSteps := horizonMin / stepMin
	if nSteps < 1 {
		nSteps = 1
	}
	last := window[valid[len(valid)-1]]
	levelNow := last.Level
	base := m.params.BaseLevel
	decay := m.params.Decay

	levels := make([]float64, nSteps)
	for k := 1; k <= nSteps; k++ {
		h := float64(k*stepMin) / 60.0
		levels[k-1] = levelNow + (base-levelNow)*decay*h
	}
	pts := buildPoints(last.Ts, levels, stepMin, m.params, m.recentRMSE, m.hasRMSE)
	return finalizeResult(pts, "naive:v1.0",
		[]string{"持久性模型：水位向基流缓慢回落（占位实现，接口与真模型一致）"}, t0), nil
}

// Describe 模型元信息。
func (m *NaiveModel) Describe() ModelMeta {
	return ModelMeta{Name: "NaiveModel", Version: "v1.0", ModelType: "naive",
		Description: "持久性占位模型：当前水位向基准水位缓慢回落（纯标量数学）"}
}
