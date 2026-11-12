// Package attribution 预测归因解释：基于预测上下文计算各因子贡献值。
// 设计原则：零侵入现有模型代码，预测完成后独立重算。
package attribution

import (
	"encoding/json"
	"fmt"
	"math"
	"time"

	"waterlog/backend/internal/agent"
	"waterlog/backend/internal/errs"
	"waterlog/backend/internal/forecast"
	"waterlog/backend/internal/store"
)

// AttributionFactor 单因子贡献
type AttributionFactor struct {
	Name        string  `json:"name"`
	Value       float64 `json:"value"`
	Unit        string  `json:"unit"`
	Percentage  float64 `json:"percentage"`
	Description string  `json:"description"`
}

// ModelInfo 模型元信息
type ModelInfo struct {
	SelectedModel   string             `json:"selectedModel"`
	ModelVersion    string             `json:"modelVersion"`
	Degraded        bool               `json:"degraded"`
	CiScale         float64            `json:"ciScale"`
	FusionWeights   agent.FusionWeights `json:"fusionWeights"`
}

// Result 归因结果
type Result struct {
	ForecastID      int64               `json:"forecastId"`
	StationID       int64               `json:"stationId"`
	StationCode     string              `json:"stationCode"`
	LeadHours       int                 `json:"leadHours"`
	BaseLevel       float64             `json:"baseLevel"`
	PredictedLevel  float64             `json:"predictedLevel"`
	PeakTime        time.Time           `json:"peakTime"`
	Factors         []AttributionFactor `json:"factors"`
	ModelInfo       ModelInfo           `json:"modelInfo"`
	Summary         string              `json:"summary"`
}

// Service 归因计算服务
type Service struct {
	store *store.Store
}

// NewService 构造归因服务。
func NewService(st *store.Store) *Service {
	return &Service{store: st}
}

// Compute 对指定预测记录执行归因计算。
func (s *Service) Compute(forecastID int64, pointIndex *int) (*Result, *errs.BizError) {
	f, err := s.store.GetForecast(forecastID)
	if err != nil || f == nil {
		return nil, errs.New(errs.RESOURCE_NOT_FOUND, "预测记录不存在（RESOURCE_NOT_FOUND）")
	}

	pts, err := s.store.GetForecastPoints(forecastID)
	if err != nil || len(pts) == 0 {
		return nil, errs.New(errs.DATA_NOT_ENOUGH, "该预测无逐点数据（DATA_NOT_ENOUGH）")
	}

	d, err := s.store.GetDecision(forecastID)
	if err != nil || d == nil {
		return nil, errs.New(errs.RESOURCE_NOT_FOUND, "该预测无决策记录，无法归因（RESOURCE_NOT_FOUND）")
	}

	station, err := s.store.GetStation(f.StationID)
	if err != nil || station == nil {
		return nil, errs.New(errs.STATION_NOT_FOUND, "监测点不存在（STATION_NOT_FOUND）")
	}

	// 确定峰值点（或用户指定点）
	idx := 0
	if pointIndex != nil && *pointIndex >= 0 && *pointIndex < len(pts) {
		idx = *pointIndex
	} else {
		for i := 1; i < len(pts); i++ {
			if pts[i].PredLevel > pts[idx].PredLevel {
				idx = i
			}
		}
	}
	peakPt := pts[idx]
	baseLevel := pts[0].PredLevel
	if peakPt.Revision != nil {
		baseLevel -= *peakPt.Revision
	}
	if baseLevel < 0 {
		baseLevel = 0
	}

	// 读取观测窗口用于重算
	predictTime := time.Unix(f.PredictTime, 0)
	hist, _ := s.store.ReadObservations(f.StationID,
		predictTime.Add(-6*time.Hour), predictTime)
	var window []forecast.Obs
	for _, r := range hist {
		o := forecast.Obs{Ts: time.Unix(r.Ts, 0), Level: forecast.NaN(), RainObserved: forecast.NaN()}
		if r.Level != nil {
			o.Level = *r.Level
		}
		if r.RainObserved != nil {
			o.RainObserved = *r.RainObserved
		}
		window = append(window, o)
	}

	// 模型参数
	params := forecast.DefaultModelParams()
	if station.BaseLevel != nil {
		params.BaseLevel = *station.BaseLevel
	}
	if station.ResponseK != nil {
		params.ResponseK = *station.ResponseK
	}

	// 解析决策中的融合权重
	var fw agent.FusionWeights
	if d.FusionWeights != nil && *d.FusionWeights != "" {
		_ = json.Unmarshal([]byte(*d.FusionWeights), &fw)
	}
	if fw == (agent.FusionWeights{}) {
		fw = agent.FusionWeights{Level: 0.45, Rain: 0.35, Fcst: 0.2}
	}

	// 计算各因子贡献
	factors := s.calculateFactors(window, pts, idx, baseLevel, params, d, fw)

	// 计算百分比（基于总变化量；净变化过小时百分比无意义，统一置 0）
	totalChange := peakPt.PredLevel - baseLevel
	changeIsMeaningful := math.Abs(totalChange) >= 0.01
	for i := range factors {
		if factors[i].Name != "当前基线水位" {
			if changeIsMeaningful {
				factors[i].Percentage = forecast.RoundN(factors[i].Value/totalChange*100, 1)
			} else {
				factors[i].Percentage = 0
			}
		}
	}

	// 生成总结文案
	summary := buildSummary(factors, baseLevel, peakPt.PredLevel, peakPt.TargetTime, station.StationCode)

	modelVersion := f.ModelType + ":v1.0"
	ciScale := 1.0
	if d.CiScale != nil {
		ciScale = *d.CiScale
	}
	degraded := false
	if d.Degraded != nil {
		degraded = *d.Degraded
	}

	return &Result{
		ForecastID:     forecastID,
		StationID:      f.StationID,
		StationCode:    station.StationCode,
		LeadHours:      f.LeadHours,
		BaseLevel:      forecast.RoundN(baseLevel, 3),
		PredictedLevel: forecast.RoundN(peakPt.PredLevel, 3),
		PeakTime:       time.Unix(peakPt.TargetTime, 0),
		Factors:        factors,
		ModelInfo: ModelInfo{
			SelectedModel: d.SelectedModel,
			ModelVersion:  modelVersion,
			Degraded:      degraded,
			CiScale:       forecast.RoundN(ciScale, 2),
			FusionWeights: fw,
		},
		Summary: summary,
	}, nil
}

// calculateFactors 计算各因子贡献值。
func (s *Service) calculateFactors(
	window []forecast.Obs,
	pts []store.ForecastPointRow,
	peakIdx int,
	baseLevel float64,
	params forecast.ModelParams,
	d *store.DecisionRow,
	fw agent.FusionWeights,
) []AttributionFactor {
	peakPt := pts[peakIdx]
	factors := []AttributionFactor{
		{Name: "当前基线水位", Value: forecast.RoundN(baseLevel, 3), Unit: "m", Percentage: 0, Description: "预测起点实测水位"},
	}

	// 降雨驱动贡献重算
	rainContribution := s.computeRainContribution(window, peakIdx, params, d.SelectedModel)
	factors = append(factors, AttributionFactor{
		Name:        "降雨驱动",
		Value:       forecast.RoundN(rainContribution, 3),
		Unit:        "m",
		Description: fmt.Sprintf("过去降雨经汇流滞后核传导，预计推高水位%.3fm", rainContribution),
	})

	// 退水回归
	drainContribution := s.computeDrainContribution(baseLevel, peakPt.PredLevel, params)
	factors = append(factors, AttributionFactor{
		Name:        "退水回归",
		Value:       forecast.RoundN(drainContribution, 3),
		Unit:        "m",
		Description: fmt.Sprintf("当前水位高于基流%.2fm，退水效应拉回%.3fm", params.BaseLevel, math.Abs(drainContribution)),
	})

	// 协同修正
	revisionTotal := 0.0
	if peakPt.Revision != nil {
		revisionTotal = *peakPt.Revision
	}
	factors = append(factors, AttributionFactor{
		Name:        "协同修正",
		Value:       forecast.RoundN(revisionTotal, 3),
		Unit:        "m",
		Description: fmt.Sprintf("基于近期预测偏差，协同修正额外调整%+.3fm", revisionTotal),
	})

	// 模型不确定度/选型说明
	modelDesc := fmt.Sprintf("选用%s模型", d.SelectedModel)
	if d.SelectedModel == "nonlinear" {
		modelDesc += "（多窗口特征+自学习参数）"
	} else if d.SelectedModel == "linear_response" {
		modelDesc += "（降雨线性响应+汇流滞后）"
	} else if d.SelectedModel == "naive" {
		modelDesc += "（持久性模型，数据不足或降级时启用）"
	}
	factors = append(factors, AttributionFactor{
		Name:        "模型不确定度",
		Value:       0,
		Unit:        "m",
		Percentage:  0,
		Description: modelDesc,
	})

	return factors
}

// computeRainContribution 重算降雨驱动贡献。
func (s *Service) computeRainContribution(window []forecast.Obs, peakIdx int, params forecast.ModelParams, modelType string) float64 {
	if len(window) == 0 {
		return 0
	}
	rainAll := forecast.EffectiveRain(window)
	valid := forecast.ValidLevels(window)
	if len(valid) == 0 {
		return 0
	}
	histLen := len(valid)
	levelNow := window[valid[len(valid)-1]].Level
	nSteps := peakIdx + 1

	lvl := levelNow
	if modelType == "nonlinear" {
		// 用默认非线性参数重算（简化：不重新fit）
		gain, kRec, sat := params.Gain, params.ResponseK, 8.0
		for j := 1; j <= nSteps; j++ {
			idx := histLen - 1 + j
			rainStep := 0.0
			if idx < len(rainAll) {
				rainStep = rainAll[idx]
			}
			inflow := gain * math.Tanh(rainStep/sat) * sat
			outflow := kRec * (lvl - params.BaseLevel)
			lvl = lvl + inflow - outflow
			if lvl < 0 {
				lvl = 0
			}
		}
	} else {
		// 线性响应
		kernel := params.Kernel()
		kLen := len(kernel)
		gain := params.Gain
		kRec := params.ResponseK
		for j := 1; j <= nSteps; j++ {
			idx := histLen - 1 + j
			lo := idx - kLen + 1
			if lo < 0 {
				lo = 0
			}
			seg := rainAll[lo : idx+1]
			if len(seg) > kLen {
				seg = seg[len(seg)-kLen:]
			}
			if len(seg) < kLen {
				padded := make([]float64, kLen)
				copy(padded[kLen-len(seg):], seg)
				seg = padded
			}
			dot := 0.0
			for i := 0; i < kLen; i++ {
				dot += kernel[i] * seg[i]
			}
			inflow := gain * dot
			lvl = lvl + inflow - kRec*(lvl-params.BaseLevel)
			if lvl < 0 {
				lvl = 0
			}
		}
	}
	return lvl - levelNow
}

// computeDrainContribution 估算退水贡献（负值）。
func (s *Service) computeDrainContribution(baseLevel, predictedLevel float64, params forecast.ModelParams) float64 {
	if predictedLevel <= baseLevel {
		return 0
	}
	// 简化：退水总量 ≈ -k * (平均超额水位) * 时间
	// 这里用经验估算：退水约占超额水位的 10-20%
	excess := predictedLevel - params.BaseLevel
	if excess < 0 {
		return 0
	}
	return -params.ResponseK * excess * 12 // 约1小时12个步长
}

func buildSummary(factors []AttributionFactor, baseLevel, predictedLevel float64, peakTimeUnix int64, stationCode string) string {
	var rainFactor, drainFactor, revisionFactor *AttributionFactor
	for i := range factors {
		switch factors[i].Name {
		case "降雨驱动":
			rainFactor = &factors[i]
		case "退水回归":
			drainFactor = &factors[i]
		case "协同修正":
			revisionFactor = &factors[i]
		}
	}
	peakTime := time.Unix(peakTimeUnix, 0).Format("15:04")
	summary := fmt.Sprintf("%s当前水位%.2fm，", stationCode, baseLevel)
	if rainFactor != nil && rainFactor.Value > 0.01 {
		if rainFactor.Percentage != 0 {
			summary += fmt.Sprintf("降雨驱动是主因（+%.2fm，占%.0f%%），", rainFactor.Value, rainFactor.Percentage)
		} else {
			// 净变化过小，百分比不可信，只报绝对量
			summary += fmt.Sprintf("降雨驱动推高水位（+%.2fm），", rainFactor.Value)
		}
	}
	if drainFactor != nil && drainFactor.Value < -0.005 {
		summary += fmt.Sprintf("退水部分抵消（%.2fm），", drainFactor.Value)
	}
	if revisionFactor != nil && math.Abs(revisionFactor.Value) > 0.005 {
		summary += fmt.Sprintf("协同修正基于近期偏差额外调整%+.2fm，", revisionFactor.Value)
	}
	summary += fmt.Sprintf("综合预计%s达%.2fm", peakTime, predictedLevel)
	return summary
}
