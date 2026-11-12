// 模型校准服务：参数校准（网格搜索 gain × response_k）+ 重训占位。
// 移植自 app/application/calibration_service.py。
package service

import (
	"encoding/json"
	"fmt"
	"math"
	"time"

	"waterlog/backend/internal/config"
	"waterlog/backend/internal/errs"
	"waterlog/backend/internal/forecast"
	"waterlog/backend/internal/store"
)

// CalibrationService 校准服务。
type CalibrationService struct {
	cfg   *config.Settings
	store *store.Store
}

// NewCalibrationService 构造。
func NewCalibrationService(cfg *config.Settings, st *store.Store) *CalibrationService {
	return &CalibrationService{cfg: cfg, store: st}
}

// CalibrateResult 参数校准结果（原型 CalibrateResult 契约）。
type CalibrateResult struct {
	ModelID      int64                  `json:"modelId"`
	StationID    int64                  `json:"stationId"`
	Method       string                 `json:"method"`
	ParamsBefore map[string]float64     `json:"paramsBefore"`
	ParamsAfter  map[string]float64     `json:"paramsAfter"`
	RmseBefore   float64                `json:"rmseBefore"`
	RmseAfter    float64                `json:"rmseAfter"`
	MaeBefore    float64                `json:"maeBefore"`
	MaeAfter     float64                `json:"maeAfter"`
	ImprovedPct  float64                `json:"improvedPct"`
}

// CalibrateParams 网格搜索最小化「模拟递推 vs 实况」RMSE，标定 gain/response_k 并写回。
func (s *CalibrationService) CalibrateParams(modelID, stationID int64, hours int, now time.Time) (*CalibrateResult, *errs.BizError) {
	if hours <= 0 {
		hours = 24
	}
	row, err := s.store.GetModel(modelID)
	if err != nil {
		return nil, errs.New(errs.MODEL_NOT_READY, "模型不存在（MODEL_NOT_READY）")
	}
	if row.ModelType != "linear_response" {
		return nil, errs.New(errs.MODEL_INPUT_MISMATCH,
			"参数校准仅支持 linear_response 模型（MODEL_INPUT_MISMATCH）")
	}
	obs, err := s.store.ReadObservations(stationID, now.Add(-time.Duration(hours)*time.Hour), now)
	if err != nil {
		return nil, errs.New(errs.DATABASE_ERROR, "历史数据读取失败（DATABASE_ERROR）")
	}
	if len(obs) < 36 {
		return nil, errs.New(errs.DATA_NOT_ENOUGH, "历史数据不足 3 小时，无法参数校准（DATA_NOT_ENOUGH）")
	}
	// 缺失值处理：按有效水位对齐（FR-2.3）
	level := make([]float64, 0, len(obs))
	rain := make([]float64, 0, len(obs))
	for _, o := range obs {
		if o.Level == nil {
			continue
		}
		level = append(level, *o.Level)
		r := 0.0
		if o.RainObserved != nil {
			r = *o.RainObserved
		}
		rain = append(rain, r)
	}
	if len(level) < 36 {
		return nil, errs.New(errs.DATA_NOT_ENOUGH, "历史数据不足 3 小时，无法参数校准（DATA_NOT_ENOUGH）")
	}
	st, _ := s.store.GetStation(stationID)
	ov := &forecast.StationOverrides{}
	if st != nil {
		ov.BaseLevel, ov.ResponseK = st.BaseLevel, st.ResponseK
	}
	algorithmConfig := ""
	if row.AlgorithmConfig != nil {
		algorithmConfig = *row.AlgorithmConfig
	}
	params0 := forecast.BuildParams(&s.cfg.Forecast, ov, algorithmConfig, stationID)
	base := level[0]
	kernel := forecast.BuildKernel(params0.KernelLen, params0.KernelTau)
	kernelLen := len(kernel)

	simulate := func(gain, kRec float64) []float64 {
		sim := make([]float64, len(level))
		lvl := base
		for i := range level {
			lo := i - kernelLen + 1
			if lo < 0 {
				lo = 0
			}
			seg := rain[lo : i+1]
			dot := 0.0
			for j, w := range kernel {
				if j < kernelLen-len(seg) {
					continue
				}
				dot += w * seg[j-(kernelLen-len(seg))]
			}
			lvl = lvl + gain*dot - kRec*(lvl-base)
			sim[i] = lvl
		}
		return sim
	}
	rmseOf := func(gain, kRec float64) float64 {
		sim := simulate(gain, kRec)
		se := 0.0
		for i := range sim {
			d := sim[i] - level[i]
			se += d * d
		}
		return math.Sqrt(se / float64(len(sim)))
	}
	maeOf := func(gain, kRec float64) float64 {
		sim := simulate(gain, kRec)
		ae := 0.0
		for i := range sim {
			d := sim[i] - level[i]
			if d < 0 {
				d = -d
			}
			ae += d
		}
		return ae / float64(len(sim))
	}

	rmseBefore := rmseOf(params0.Gain, params0.ResponseK)
	maeBefore := maeOf(params0.Gain, params0.ResponseK)
	bestGain, bestK, bestRMSE := params0.Gain, params0.ResponseK, rmseBefore
	for gi := 1; gi <= 10; gi++ { // np.arange(0.001, 0.0101, 0.001)
		gain := float64(gi) * 0.001
		for ki := 1; ki <= 9; ki++ { // np.arange(0.004, 0.0201, 0.002)
			kRec := 0.004 + float64(ki-1)*0.002
			if kRec > 0.0201 {
				break
			}
			if r := rmseOf(gain, kRec); r < bestRMSE {
				bestGain, bestK, bestRMSE = forecast.RoundN(gain, 4), forecast.RoundN(kRec, 4), r
			}
		}
	}
	rmseAfter := bestRMSE
	maeAfter := maeOf(bestGain, bestK)

	params := map[string]any{
		"gain": bestGain, "response_k": bestK,
		"kernel_len": params0.KernelLen, "kernel_tau": params0.KernelTau,
	}
	metrics := map[string]any{
		"rmse_before": forecast.RoundN(rmseBefore, 4), "rmse_after": forecast.RoundN(rmseAfter, 4),
		"mae_before": forecast.RoundN(maeBefore, 4), "mae_after": forecast.RoundN(maeAfter, 4),
	}
	if err := s.store.SaveCalibration(modelID, stationID, params, metrics); err != nil {
		return nil, errs.New(errs.DATABASE_ERROR, "标定参数写回失败（DATABASE_ERROR）")
	}
	// 校准记录（原型 CalibrationRecord 契约）
	before, _ := json.Marshal(map[string]float64{"gain": params0.Gain, "responseK": params0.ResponseK})
	after, _ := json.Marshal(map[string]float64{"gain": bestGain, "responseK": bestK})
	target := fmt.Sprintf("model:%d/station:%d", modelID, stationID)
	note := "网格搜索标定 gain × response_k，已写回 model.algorithm_config"
	_, _ = s.store.CreateCalibration(&store.CalibrationRow{
		Type: "param", Target: &target, BeforeJSON: ptrStr(string(before)),
		AfterJSON: ptrStr(string(after)), Status: "applied", ExecutedBy: ptrStr("system"), Note: &note,
	})

	improved := 0.0
	if rmseBefore != 0 {
		improved = forecast.RoundN((1-rmseAfter/rmseBefore)*100, 2)
	}
	return &CalibrateResult{
		ModelID: modelID, StationID: stationID, Method: "grid_search(gain × response_k)",
		ParamsBefore: map[string]float64{"gain": params0.Gain, "response_k": params0.ResponseK},
		ParamsAfter:  map[string]float64{"gain": bestGain, "response_k": bestK},
		RmseBefore:   forecast.RoundN(rmseBefore, 4), RmseAfter: forecast.RoundN(rmseAfter, 4),
		MaeBefore:    forecast.RoundN(maeBefore, 4), MaeAfter: forecast.RoundN(maeAfter, 4),
		ImprovedPct:  improved,
	}, nil
}

// CreateRetrainTask 重训占位：受理并记录任务，不执行训练（EXT-POINT(MODEL)）。
func (s *CalibrationService) CreateRetrainTask(stationID, baseModelID *int64) (map[string]any, *errs.BizError) {
	req, _ := json.Marshal(map[string]any{"stationId": stationID, "baseModelId": baseModelID})
	taskID, err := s.store.CreateTask("model_retrain", string(req), "pending")
	if err != nil {
		return nil, errs.New(errs.DATABASE_ERROR, "任务创建失败（DATABASE_ERROR）")
	}
	target := ""
	if stationID != nil {
		target = fmt.Sprintf("station:%d", *stationID)
	}
	note := "模型重训为占位功能：已受理并记录任务，训练执行位待填充（EXT-POINT(MODEL)）"
	if _, err := s.store.CreateCalibration(&store.CalibrationRow{
		Type: "retrain", Target: &target, Status: "pending", ExecutedBy: ptrStr("system"), Note: &note,
	}); err != nil {
		return nil, errs.New(errs.DATABASE_ERROR, "校准记录写入失败（DATABASE_ERROR）")
	}
	return map[string]any{
		"calibrationId": taskID, "taskType": "model_retrain", "status": "pending",
		"stationId": stationID, "baseModelId": baseModelID,
		"createdAt": time.Now().Unix(), "note": note,
	}, nil
}
