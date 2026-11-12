// LgbmModel 占位模型：调用即抛 MODEL_NOT_READY(1201)。
// 移植自 app/infrastructure/forecast/lgbm_model.py（占位语义一致）。
package forecast

import (
	"waterlog/backend/internal/errs"
)

type LgbmModel struct{ params ModelParams }

// NewLgbmModel 构造占位模型。
func NewLgbmModel(p ModelParams) *LgbmModel { return &LgbmModel{params: p} }

// Fit 占位模型无训练。
func (m *LgbmModel) Fit(history []Obs) {}

// SetRecentRMSE 占位模型无近期误差。
func (m *LgbmModel) SetRecentRMSE(rmse float64, has bool) {}

// ModelType 模型类型标识。
func (m *LgbmModel) ModelType() string { return "lgbm" }

// Predict 调用即抛 MODEL_NOT_READY。
func (m *LgbmModel) Predict(window []Obs, horizonMin int) (*ForecastResult, *errs.BizError) {
	return nil, errs.New(errs.MODEL_NOT_READY, "LGBM 模型未就绪：本期为占位实现，预测执行位待填充（MODEL_NOT_READY）")
}

// Describe 模型元信息。
func (m *LgbmModel) Describe() ModelMeta {
	return ModelMeta{Name: "LgbmModel", Version: "v1.0", ModelType: "lgbm",
		Description: "LightGBM 占位模型（未实现，调用即抛 MODEL_NOT_READY）"}
}

var _ Model = (*LgbmModel)(nil)
