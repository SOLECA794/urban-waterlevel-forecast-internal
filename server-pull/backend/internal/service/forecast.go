// 预测用例编排（应用层）：数据治理 → Agent-A 决策 → 模型推理 → 协同修正 → 落库 → 研判。
// 移植自 app/application/forecast_service.py（编排逻辑照搬，依赖注入改为 Go 构造函数）。
package service

import (
	"encoding/json"
	"math"
	"sort"
	"sync"
	"time"

	"waterlog/backend/internal/agent"
	"waterlog/backend/internal/config"
	"waterlog/backend/internal/datasource"
	"waterlog/backend/internal/errs"
	"waterlog/backend/internal/forecast"
	"waterlog/backend/internal/store"
)

// ForecastService 预测服务。
type ForecastService struct {
	cfg    *config.Settings
	store  *store.Store
	alerts *AlertService
	orch   *agent.Orchestrator
	rev    *RevisionService
	source *datasource.SimulatedSource
	pre    *datasource.Preprocessor

	mu            sync.Mutex
	lastRainTotal map[int64]float64 // 上一版预报总量缓存（e_rain 新息来源）
}

// NewForecastService 构造。
func NewForecastService(cfg *config.Settings, st *store.Store, alerts *AlertService,
	orch *agent.Orchestrator, rev *RevisionService, source *datasource.SimulatedSource) *ForecastService {
	return &ForecastService{
		cfg: cfg, store: st, alerts: alerts, orch: orch, rev: rev, source: source,
		pre:            datasource.NewPreprocessor(cfg.Forecast.StepMinutes),
		lastRainTotal:  map[int64]float64{},
	}
}

// PointPayload 预测逐点（修正前后 + 区间）。
type PointPayload struct {
	T        time.Time
	LevelRaw float64
	Level    float64
	Revision float64
	Lower    float64
	Upper    float64
}

// PredictionResult run_prediction 端到端输出。
type PredictionResult struct {
	ForecastID        int64
	Station           *store.StationRow
	ModelID           int64
	ModelType         string
	LeadHours         int
	PredictTime       time.Time
	HorizonEndTime    time.Time
	Points            []PointPayload
	PeakLevel         float64
	PeakTime          time.Time
	ConfidenceLower   float64
	ConfidenceUpper   float64
	Degraded          bool
	Decision          *agent.Decision
	Alert             *store.AlertRow
}

func (s *ForecastService) obsFromRows(rows []store.ObservationRow) []forecast.Obs {
	out := make([]forecast.Obs, 0, len(rows))
	for _, r := range rows {
		o := forecast.Obs{Ts: time.Unix(r.Ts, 0), Level: forecast.NaN(), RainObserved: forecast.NaN(), RainForecast: forecast.NaN()}
		if r.Level != nil {
			o.Level = *r.Level
		}
		if r.RainObserved != nil {
			o.RainObserved = *r.RainObserved
		}
		if r.RainForecast != nil {
			o.RainForecast = *r.RainForecast
		}
		out = append(out, o)
	}
	return out
}

// historyWindow 读历史窗口（小时数与原 _history_window 一致）。
func (s *ForecastService) historyWindow(stationID int64, needRows int, now time.Time) []forecast.Obs {
	hours := s.cfg.Forecast.MinHistoryHours * 2
	if v := needRows*s.cfg.Forecast.StepMinutes/60 + 2; v > hours {
		hours = v
	}
	rows, err := s.store.ReadObservations(stationID, now.Add(-time.Duration(hours)*time.Hour), now)
	if err != nil {
		return nil
	}
	return s.obsFromRows(rows)
}

// quality 数据源质量画像（近 3h 缺失率 + 样本滞后 + 链路状态）。
func (s *ForecastService) quality(hist []forecast.Obs, recentRMSE *float64, now time.Time) agent.SourceQuality {
	step := s.cfg.Forecast.StepMinutes
	var age *float64
	if len(hist) > 0 {
		v := math.Max(0, now.Sub(hist[len(hist)-1].Ts).Minutes())
		age = &v
	}
	status := s.source.StatusValue(age)
	if len(hist) == 0 {
		return agent.SourceQuality{Status: status, MissingRate: 1.0, LastSampleAgeMin: 9999, RecentRMSE: recentRMSE}
	}
	last := hist[len(hist)-1].Ts
	ageMin := math.Max(0, now.Sub(last).Minutes())
	expected := 3*60/step + 1
	inWin := 0
	cutoff := now.Add(-3 * time.Hour)
	for _, o := range hist {
		if !o.Ts.Before(cutoff) {
			inWin++
		}
	}
	missing := float64(expected-inWin) / float64(expected)
	if missing < 0 {
		missing = 0
	}
	return agent.SourceQuality{
		Status: status, MissingRate: forecast.RoundN(math.Min(1.0, missing), 3),
		LastSampleAgeMin: forecast.RoundN(ageMin, 2), RecentRMSE: recentRMSE,
	}
}

// innovation 近 90 分钟已落地时段的新息：actual − predicted 均值（m）。
// 锚定约 90 分钟前签发的一版预测（评审 P1-6 口径修正）。
func (s *ForecastService) innovation(stationID int64, now time.Time) float64 {
	step := s.cfg.Forecast.StepMinutes
	rows, _, err := s.store.ListForecastsForStation(stationID, nil, 1, 40)
	if err != nil || len(rows) == 0 {
		return 0
	}
	var anchor *store.ForecastRow
	cutoff := now.Add(-(90 - 15) * time.Minute).Unix()
	for i := range rows { // 按 forecast_id 倒序（最新在前）
		if rows[i].PredictTime <= cutoff {
			anchor = &rows[i]
			break
		}
	}
	if anchor == nil {
		anchor = &rows[len(rows)-1]
	}
	pts, err := s.store.GetForecastPoints(anchor.ForecastID)
	if err != nil {
		return 0
	}
	var past []store.ForecastPointRow
	lo, hi := now.Add(-90*time.Minute).Unix(), now.Unix()
	for _, p := range pts {
		if p.TargetTime >= lo && p.TargetTime <= hi {
			past = append(past, p)
		}
	}
	if len(past) == 0 {
		return 0
	}
	obsRows, err := s.store.ReadObservations(stationID,
		time.Unix(past[0].TargetTime, 0).Add(-time.Duration(step)*time.Minute), now)
	if err != nil || len(obsRows) == 0 {
		return 0
	}
	type pair struct {
		ts  int64
		lvl float64
	}
	obs := []pair{}
	for _, r := range obsRows {
		if r.Level != nil {
			obs = append(obs, pair{r.Ts, *r.Level})
		}
	}
	if len(obs) == 0 {
		return 0
	}
	tolSec := int64(step * 60)
	gaps := []float64{}
	for _, p := range past {
		best := obs[0]
		bestDiff := int64(math.MaxInt64)
		for _, o := range obs {
			d := o.ts - p.TargetTime
			if d < 0 {
				d = -d
			}
			if d < bestDiff {
				bestDiff, best = d, o
			}
		}
		if bestDiff <= tolSec {
			gaps = append(gaps, best.lvl-p.PredLevel)
		}
	}
	if len(gaps) == 0 {
		return 0
	}
	sum := 0.0
	for _, g := range gaps {
		sum += g
	}
	return forecast.RoundN(sum/float64(len(gaps)), 4)
}

// buildWindow 构造模型输入窗口：历史行（level 有值）+ 未来行（rain_forecast 有值）。
func (s *ForecastService) buildWindow(hist []forecast.Obs, station *store.StationRow,
	leadHours, needRows int) []forecast.Obs {
	step := s.cfg.Forecast.StepMinutes
	tailN := needRows
	if tailN < 24 {
		tailN = 24
	}
	if tailN > len(hist) {
		tailN = len(hist)
	}
	win := append([]forecast.Obs{}, hist[len(hist)-tailN:]...)
	nowFloor := hist[len(hist)-1].Ts
	lat, lon := 30.0, 120.0
	if station.Latitude != nil {
		lat = *station.Latitude
	}
	if station.Longitude != nil {
		lon = *station.Longitude
	}
	fc := s.source.GetRainForecast(station.StationID, nowFloor, leadHours+1, step, lat, lon)
	hiBound := nowFloor.Add(time.Duration(leadHours*60) * time.Minute).Unix()
	for _, f := range fc {
		if f.Ts.Unix() > nowFloor.Unix() && f.Ts.Unix() <= hiBound {
			win = append(win, forecast.Obs{
				Ts: f.Ts, Level: forecast.NaN(), RainObserved: forecast.NaN(), RainForecast: f.RainForecast,
			})
		}
	}
	sort.Slice(win, func(i, j int) bool { return win[i].Ts.Before(win[j].Ts) })
	return win
}

// rainInnovation 最新预报量 − 上一版预报量（近 1h 总量，mm）。
func (s *ForecastService) rainInnovation(stationID int64, window []forecast.Obs) float64 {
	var first time.Time
	total := 0.0
	n := 0
	for _, o := range window {
		if !math.IsNaN(o.RainForecast) {
			if n == 0 {
				first = o.Ts
			}
			if !o.Ts.After(first.Add(time.Hour)) {
				total += o.RainForecast
			}
			n++
		}
	}
	if n == 0 {
		return 0
	}
	s.mu.Lock()
	prev, has := s.lastRainTotal[stationID]
	s.lastRainTotal[stationID] = total
	s.mu.Unlock()
	if !has {
		return 0
	}
	return forecast.RoundN(total-prev, 3)
}

// RunPrediction 端到端执行一次预测（FR 2.x 全链路）。
func (s *ForecastService) RunPrediction(stationID int64, leadHours int, modelID *int64,
	now time.Time) (*PredictionResult, *errs.BizError) {
	station, err := s.store.GetStation(stationID)
	if err != nil {
		return nil, errs.New(errs.STATION_NOT_FOUND, "监测点不存在（STATION_NOT_FOUND）")
	}
	if !station.Enabled {
		return nil, errs.New(errs.STATION_STATE_INVALID, "监测点已停用（STATION_STATE_INVALID）")
	}
	leadOK := false
	for _, l := range s.cfg.Forecast.LeadHours {
		if l == leadHours {
			leadOK = true
			break
		}
	}
	if !leadOK {
		return nil, errs.New(errs.PARAM_INVALID, "不支持的预见期（PARAM_INVALID）")
	}

	step := s.cfg.Forecast.StepMinutes
	minRows := s.cfg.Forecast.MinHistoryHours * 60 / step
	hist := s.historyWindow(stationID, minRows+48, now)
	// FR一.2/分析模式1：显式数据预处理（对齐+清洗+填补+特征工程）
	feats, _ := s.pre.Process(hist)
	hist = make([]forecast.Obs, 0, len(feats))
	for _, f := range feats {
		hist = append(hist, forecast.Obs{Ts: f.Ts, Level: f.Level, RainObserved: f.RainObserved})
	}
	valid := hist[:0:0]
	for _, o := range hist {
		if !math.IsNaN(o.Level) {
			valid = append(valid, o)
		}
	}
	if len(valid) == 0 {
		return nil, errs.New(errs.DATA_NOT_ENOUGH, "监测点无有效历史数据，拒绝预测（DATA_NOT_ENOUGH）")
	}
	recentRMSE, _ := s.store.RecentRMSEForStation(stationID)
	quality := s.quality(hist, recentRMSE, now)

	// ---- Agent-A 决策（D1–D5） ----
	var modelRow *store.ModelRow
	if modelID != nil {
		m, err := s.store.GetModel(*modelID)
		if err != nil {
			return nil, errs.New(errs.MODEL_NOT_READY, "模型不存在（MODEL_NOT_READY）")
		}
		if m.ModelFile == "" {
			return nil, errs.New(errs.MODEL_NOT_READY, "模型为占位版本（MODEL_NOT_READY）")
		}
		modelRow = m
	}
	activeType := s.cfg.Forecast.ModelType
	if active, err := s.store.GetActiveModel(); err == nil && active != nil {
		activeType = active.ModelType
	}
	ctx := &agent.ForecastContext{
		StationID: stationID, StationCode: station.StationCode, LeadHours: leadHours,
		HistoryRows: len(valid), MinRows: minRows,
		Innovation:  s.innovation(stationID, now),
		Quality:     quality, ActiveModelType: activeType,
	}
	decision := s.orch.Decide(ctx)
	if modelRow != nil {
		if decision.Degraded {
			// P1-5（评审）：降级态下追溯面板不能自相矛盾——D1 显示实际执行模型
			decision.Reason += "；降级态下忽略人工指定模型，按 D5 实际执行 naive（D1 未被覆盖）"
			modelRow = nil
		} else {
			decision.SelectedModel = modelRow.ModelType
			decision.Reason += "（应请求指定模型，D1 被人工覆盖）"
		}
	}

	// ---- 模型推理 ----
	chosenModelID := int64(1)
	algorithmConfig := ""
	chosenType := decision.SelectedModel
	if modelRow != nil {
		chosenModelID = modelRow.ModelID
		chosenType = modelRow.ModelType
		if modelRow.AlgorithmConfig != nil {
			algorithmConfig = *modelRow.AlgorithmConfig
		}
	} else {
		if ms, err := s.store.ListModels(); err == nil {
			for _, m := range ms {
				if m.ModelType == decision.SelectedModel && m.ModelFile != "" {
					chosenModelID = m.ModelID
					if m.AlgorithmConfig != nil {
						algorithmConfig = *m.AlgorithmConfig
					}
					break
				}
			}
		}
	}
	ov := &forecast.StationOverrides{BaseLevel: station.BaseLevel, ResponseK: station.ResponseK}
	params := forecast.BuildParams(&s.cfg.Forecast, ov, algorithmConfig, stationID)
	model, berr := forecast.Create(decision.SelectedModel, params)
	if berr != nil {
		return nil, berr
	}
	model.SetRecentRMSE(0, false)
	if recentRMSE != nil {
		model.SetRecentRMSE(*recentRMSE, true)
	}
	window := s.buildWindow(valid, station, leadHours, minRows+48)
	// 参数自学习：用历史窗口拟合非线性模型参数（FR 模型校准优化）
	model.Fit(valid)
	result, berr := model.Predict(window, leadHours*60)
	if berr != nil {
		return nil, berr
	}

	// ---- 协同修正（V1.3 多源加权新息 + 时间衰减 + 已发生事件） ----
	rainInnov := s.rainInnovation(stationID, window)
	eventBonus := 0.0
	if actives, err := s.store.ActiveAlertsForStation(stationID); err == nil {
		cutoff := now.Add(-24 * time.Hour).Unix()
		for _, a := range actives {
			if a.AlertTime >= cutoff {
				eventBonus = 0.05
				break
			}
		}
	}
	predictTime := now
	revisions := s.rev.Apply(result.Points, &decision, predictTime,
		ctx.Innovation, rainInnov, 0.0, eventBonus, step)

	// ---- 落库：forecast 主记录 + 逐点明细 + 决策 ----
	corrected := make([]float64, len(revisions))
	for i, r := range revisions {
		corrected[i] = r.Corrected
	}
	peakIdx := 0
	for i := 1; i < len(corrected); i++ {
		if corrected[i] > corrected[peakIdx] {
			peakIdx = i
		}
	}
	peakLevel := 0.0
	peakTime := predictTime
	peakTimeUnix := peakTime.Unix()
	var pts []PointPayload
	if len(result.Points) > 0 {
		peakLevel = corrected[peakIdx]
		peakTime = result.Points[peakIdx].T
		peakTimeUnix = peakTime.Unix()
	}
	remark := ""
	if len(result.Notes) > 0 {
		for i, n := range result.Notes {
			if i > 0 {
				remark += "；"
			}
			remark += n
		}
	}
	frow := &store.ForecastRow{
		StationID: stationID, ModelID: &chosenModelID, ModelType: chosenType,
		LeadHours: leadHours, PredictTime: predictTime.Unix(),
		HorizonEndTime: predictTime.Add(time.Duration(leadHours) * time.Hour).Unix(),
		PeakLevel: &peakLevel, PeakTime: &peakTimeUnix, Degraded: decision.Degraded,
	}
	if remark != "" {
		frow.Remark = &remark
	}
	forecastID, err := s.store.CreateForecast(frow)
	if err != nil {
		return nil, errs.New(errs.DATABASE_ERROR, "预测落库失败（DATABASE_ERROR）")
	}
	dbPoints := make([]store.ForecastPointRow, 0, len(result.Points))
	for i, rp := range result.Points {
		halfRaw := (rp.Upper - rp.Lower) / 2.0
		half := s.rev.WidenCI(halfRaw, rp.T, predictTime)
		pts = append(pts, PointPayload{
			T: rp.T, LevelRaw: rp.LevelRaw, Level: revisions[i].Corrected,
			Revision: revisions[i].Revision,
			Lower:    forecast.RoundN(revisions[i].Corrected-half, 4),
			Upper:    forecast.RoundN(revisions[i].Corrected+half, 4),
		})
		dbPoints = append(dbPoints, store.ForecastPointRow{
			ForecastID: forecastID,
			LeadMinutes: int(rp.T.Sub(predictTime).Minutes()),
			TargetTime:  rp.T.Unix(), PredLevelRaw: rp.LevelRaw,
			Revision: &revisions[i].Revision, PredLevel: revisions[i].Corrected,
			LowerBound: &pts[i].Lower, UpperBound: &pts[i].Upper,
		})
	}
	if err := s.store.AddForecastPoints(forecastID, dbPoints); err != nil {
		return nil, errs.New(errs.DATABASE_ERROR, "预测逐点落库失败（DATABASE_ERROR）")
	}
	fw, _ := json.Marshal(decision.FusionWeights)
	alpha, ciScale := decision.RevisionAlpha, decision.CiScale
	if err := s.store.AddDecision(&store.DecisionRow{
		ForecastID: forecastID, SelectedModel: decision.SelectedModel,
		FusionWeights: ptrStr(string(fw)), RevisionAlpha: &alpha, CiScale: &ciScale,
		Degraded: &decision.Degraded, Reason: &decision.Reason,
	}); err != nil {
		return nil, errs.New(errs.DATABASE_ERROR, "决策落库失败（DATABASE_ERROR）")
	}

	// ---- 研判预警（基于修正后曲线） ----
	curve := make([]CurvePoint, len(pts))
	for i, p := range pts {
		curve[i] = CurvePoint{T: p.T, Level: p.Level}
	}
	alert, _ := s.alerts.EvaluateAfterForecast(station, forecastID, curve, leadHours)

	return &PredictionResult{
		ForecastID: forecastID, Station: station, ModelID: chosenModelID, ModelType: chosenType,
		LeadHours: leadHours, PredictTime: predictTime,
		HorizonEndTime: predictTime.Add(time.Duration(leadHours) * time.Hour),
		Points: pts, PeakLevel: peakLevel, PeakTime: peakTime,
		ConfidenceLower: result.ConfidenceInterval.Lower, ConfidenceUpper: result.ConfidenceInterval.Upper,
		Degraded: decision.Degraded, Decision: &decision, Alert: alert,
	}, nil
}

// BackfillActuals 回填已到期逐点的实况水位（精度闭环）。
func (s *ForecastService) BackfillActuals(now time.Time) int {
	step := s.cfg.Forecast.StepMinutes
	pending, err := s.store.PendingActualPoints(now, 2000)
	if err != nil || len(pending) == 0 {
		return 0
	}
	type update = struct {
		ForecastID  int64
		LeadMinutes int
		Actual      float64
	}
	updates := []update{}
	stationOf := map[int64]int64{}
	for _, p := range pending {
		sid, ok := stationOf[p.ForecastID]
		if !ok {
			f, err := s.store.GetForecast(p.ForecastID)
			if err != nil || f == nil {
				continue
			}
			sid = f.StationID
			stationOf[p.ForecastID] = sid
		}
		obs, err := s.store.ReadObservations(sid,
			time.Unix(p.TargetTime, 0).Add(-time.Duration(step)*time.Minute),
			time.Unix(p.TargetTime, 0).Add(time.Duration(step)*time.Minute))
		if err != nil || len(obs) == 0 {
			continue
		}
		last := obs[len(obs)-1]
		if last.Level != nil {
			updates = append(updates, update{p.ForecastID, p.LeadMinutes, *last.Level})
		}
	}
	if len(updates) == 0 {
		return 0
	}
	n, _ := s.store.BackfillActual(updates)
	return n
}

// RollingRound 对所有启用监测点执行一轮滚动预测（调度器调用）。
func (s *ForecastService) RollingRound(now time.Time) map[string]int {
	s.BackfillActuals(now)
	done := 0
	stations, _ := s.store.ListStations(true)
	for _, st := range stations {
		for _, lead := range s.cfg.Forecast.LeadHours {
			if _, berr := s.RunPrediction(st.StationID, lead, nil, now); berr == nil {
				done++
			}
		}
	}
	return map[string]int{"forecasts": done}
}

func ptrStr(s string) *string { return &s }
