// 模型注册与工厂 + 参数装配。
// 移植自 app/infrastructure/forecast/registry.py。
package forecast

import (
	"encoding/json"
	"strconv"

	"waterlog/backend/internal/config"
	"waterlog/backend/internal/errs"
)

// StationOverrides 站点级覆盖（base_level/response_k 可空）。
type StationOverrides struct {
	BaseLevel *float64
	ResponseK *float64
}

// BuildParams 构造模型参数：默认 ← 站点覆盖（base/responseK） ← 标定覆盖（calibration）。
// algorithmConfig 为 model.algorithm_config 的 JSON 串（可空）。
func BuildParams(cfg *config.ForecastConfig, ov *StationOverrides,
	algorithmConfig string, stationID int64) ModelParams {
	p := DefaultModelParams()
	lr := cfg.LinearResponse
	p.Gain = lr.Gain
	p.KernelLen = lr.KernelLen
	p.KernelTau = lr.KernelTau
	p.ResponseK = lr.ResponseK
	p.Decay = lr.Decay
	p.CIBase = lr.CIBase
	p.CISqrtFactor = lr.CISqrtFactor
	if ov != nil {
		if ov.BaseLevel != nil {
			p.BaseLevel = *ov.BaseLevel
		}
		if ov.ResponseK != nil {
			p.ResponseK = *ov.ResponseK
		}
	}
	if algorithmConfig != "" && stationID != 0 {
		var cfgObj map[string]any
		if err := json.Unmarshal([]byte(algorithmConfig), &cfgObj); err == nil {
			if calibAny, ok := cfgObj["calibration"].(map[string]any); ok {
				if calib, ok := calibAny[strconv.FormatInt(stationID, 10)].(map[string]any); ok {
					if pm, ok := calib["params"].(map[string]any); ok {
						setIf := func(key string, dst func(any)) {
							if v, ok := pm[key]; ok {
								dst(v)
							}
						}
						setIf("gain", func(v any) {
							if f, ok := v.(float64); ok {
								p.Gain = f
							}
						})
						setIf("response_k", func(v any) {
							if f, ok := v.(float64); ok {
								p.ResponseK = f
							}
						})
						setIf("base_level", func(v any) {
							if f, ok := v.(float64); ok {
								p.BaseLevel = f
							}
						})
						setIf("kernel_len", func(v any) {
							if f, ok := v.(float64); ok {
								p.KernelLen = int(f)
							}
						})
						setIf("kernel_tau", func(v any) {
							if f, ok := v.(float64); ok {
								p.KernelTau = f
							}
						})
					}
				}
			}
		}
	}
	return p
}

// ModelTypes 支持的模型类型清单。
var ModelTypes = []string{"naive", "linear_response", "lgbm", "nonlinear"}

// Create 按模型类型构造实例（未知类型抛 1202）。
func Create(modelType string, p ModelParams) (Model, *errs.BizError) {
	switch modelType {
	case "naive":
		return NewNaiveModel(p), nil
	case "linear_response":
		return NewLinearResponseModel(p), nil
	case "lgbm":
		return NewLgbmModel(p), nil
	case "nonlinear":
		return NewNonlinearRunoffModel(p), nil
	default:
		return nil, errs.New(errs.MODEL_INPUT_MISMATCH,
			"未知模型类型 "+modelType+"（MODEL_INPUT_MISMATCH）")
	}
}
