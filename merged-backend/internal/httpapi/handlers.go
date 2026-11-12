// handlers：system / 配置（等级、预见期、渠道）/ stations / forecasts。
package httpapi

import (
	"encoding/json"
	"io"
	"fmt"
	"log"
	"math"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"waterlog/backend/internal/agent"
	"waterlog/backend/internal/errs"
	"waterlog/backend/internal/forecast"
	"waterlog/backend/internal/store"
)

// ---------- system ----------

func (a *API) systemStatus(w http.ResponseWriter, r *http.Request) {
	modelName, modelType, version := "—", "—", "—"
	var activeID *int64
	if m, err := a.store.GetActiveModel(); err == nil && m != nil {
		modelName, modelType, version = m.ModelName, m.ModelType, m.Version
		activeID = &m.ModelID
	}
	stationCount, _ := a.store.CountStations()
	writeOK(w, map[string]any{
		"modelName": modelName, "modelType": modelType, "version": version,
		"activeModelId": activeID,
		"forecastIntervalMinutes": a.cfg.Forecast.ScheduleMinutes,
		"leadHours":               a.cfg.Forecast.LeadHours,
		"stepMinutes":             a.cfg.Forecast.StepMinutes,
		"serverTime":              time.Now().Format(time.RFC3339),
		"demoMode":                a.cfg.DemoMode,
		"openMeteoEnabled":        a.cfg.OpenMeteoEnabled,
		"stationCount":            stationCount,
	})
}

// ---------- 配置：等级 / 预见期 / 渠道 ----------

func (a *API) levelDTOs(rows []store.AlertLevelRow) []AlertLevelDTO {
	out := make([]AlertLevelDTO, 0, len(rows))
	for _, l := range rows {
		rank := l.Rank
		out = append(out, AlertLevelDTO{
			Rank: &rank, Name: l.Name, LevelKey: l.LevelKey, Color: l.Color,
			WaterLevelThreshold: l.WaterLevelThreshold, DurationThreshold: l.DurationThreshold,
			Description: l.Description, Enabled: l.Enabled,
		})
	}
	return out
}

func (a *API) getAlertLevels(w http.ResponseWriter, r *http.Request) {
	rows, err := a.store.AlertLevels()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, a.levelDTOs(rows))
}

func (a *API) putAlertLevels(w http.ResponseWriter, r *http.Request) {
	// 兼容两种 body：数组直传 [ {...} ] 或包裹 { "levels": [...] }
	raw, _ := io.ReadAll(r.Body)
	var levels []AlertLevelDTO
	if err := json.Unmarshal(raw, &levels); err != nil {
		var wrapped struct {
			Levels []AlertLevelDTO `json:"levels"`
		}
		if err2 := json.Unmarshal(raw, &wrapped); err2 != nil || len(wrapped.Levels) == 0 {
			writeErr(w, errs.New(errs.PARAM_INVALID, "请求体解析失败（PARAM_INVALID）"))
			return
		}
		levels = wrapped.Levels
	}
	if len(levels) < 3 || len(levels) > 5 {
		writeErr(w, errs.New(errs.PARAM_INVALID, "预警等级数量仅支持 3–5 级（PARAM_INVALID）"))
		return
	}
	rows := make([]store.AlertLevelRow, 0, len(levels))
	for i, l := range levels {
		if l.LevelKey == "" {
			writeErr(w, errs.New(errs.PARAM_INVALID, "等级 levelKey 不能为空（PARAM_INVALID）"))
			return
		}
		rank := i
		if l.Rank != nil && *l.Rank >= 0 {
			rank = *l.Rank
		}
		rows = append(rows, store.AlertLevelRow{
			Rank: rank, Name: l.Name, LevelKey: l.LevelKey, Color: l.Color,
			WaterLevelThreshold: l.WaterLevelThreshold, DurationThreshold: l.DurationThreshold,
			Description: l.Description, Enabled: l.Enabled,
		})
	}
	if err := a.store.ReplaceAlertLevels(rows); err != nil {
		log.Printf("[httpapi] 等级配置保存失败: %v", err)
		writeErr(w, errs.New(errs.DATABASE_ERROR, "等级配置保存失败（DATABASE_ERROR）"))
		return
	}
	a.bus.Publish("config.alert_levels", map[string]any{"count": len(rows)})
	saved, _ := a.store.AlertLevels()
	writeOK(w, a.levelDTOs(saved))
}

func (a *API) getLeads(w http.ResponseWriter, r *http.Request) {
	rows, err := a.store.LeadConfigs()
	if err != nil {
		writeErr(w, err)
		return
	}
	out := make([]LeadDTO, 0, len(rows))
	for _, l := range rows {
		out = append(out, LeadDTO{Lead: l.LeadHours, Enabled: l.Enabled,
			DefaultWeight: l.DefaultWeight, IsReserved: l.IsReserved})
	}
	writeOK(w, out)
}

func (a *API) putLeads(w http.ResponseWriter, r *http.Request) {
	// 兼容数组直传或 { "leads": [...] }
	raw, _ := io.ReadAll(r.Body)
	var leads []LeadDTO
	if err := json.Unmarshal(raw, &leads); err != nil {
		var wrapped struct {
			Leads []LeadDTO `json:"leads"`
		}
		if err2 := json.Unmarshal(raw, &wrapped); err2 != nil || len(wrapped.Leads) == 0 {
			writeErr(w, errs.New(errs.PARAM_INVALID, "请求体解析失败（PARAM_INVALID）"))
			return
		}
		leads = wrapped.Leads
	}
	if len(leads) == 0 {
		writeErr(w, errs.New(errs.PARAM_INVALID, "预见期配置不能为空（PARAM_INVALID）"))
		return
	}
	rows := make([]store.LeadConfigRow, 0, len(leads))
	for _, l := range leads {
		enabled := l.Enabled
		if l.Lead <= 1 { // 1h 最低预见期始终启用
			enabled = true
		}
		rows = append(rows, store.LeadConfigRow{LeadHours: l.Lead, Enabled: enabled,
			DefaultWeight: l.DefaultWeight, IsReserved: l.IsReserved})
	}
	if err := a.store.ReplaceLeadConfigs(rows); err != nil {
		log.Printf("[httpapi] 预见期配置保存失败: %v", err)
		writeErr(w, errs.New(errs.DATABASE_ERROR, "预见期配置保存失败（DATABASE_ERROR）"))
		return
	}
	saved, _ := a.store.LeadConfigs()
	out := make([]LeadDTO, 0, len(saved))
	for _, l := range saved {
		out = append(out, LeadDTO{Lead: l.LeadHours, Enabled: l.Enabled,
			DefaultWeight: l.DefaultWeight, IsReserved: l.IsReserved})
	}
	writeOK(w, out)
}

func (a *API) getChannels(w http.ResponseWriter, r *http.Request) {
	rows, err := a.store.PublishChannels()
	if err != nil {
		writeErr(w, err)
		return
	}
	out := make([]ChannelDTO, 0, len(rows))
	for _, c := range rows {
		out = append(out, ChannelDTO{ID: c.ID, Type: c.Type, Name: c.Name,
			Enabled: c.Enabled, Endpoint: c.Endpoint, Template: c.Template})
	}
	writeOK(w, out)
}

func (a *API) putChannels(w http.ResponseWriter, r *http.Request) {
	// 兼容数组直传或 { "channels": [...] }
	raw, _ := io.ReadAll(r.Body)
	var channels []ChannelDTO
	if err := json.Unmarshal(raw, &channels); err != nil {
		var wrapped struct {
			Channels []ChannelDTO `json:"channels"`
		}
		if err2 := json.Unmarshal(raw, &wrapped); err2 != nil || len(wrapped.Channels) == 0 {
			writeErr(w, errs.New(errs.PARAM_INVALID, "请求体解析失败（PARAM_INVALID）"))
			return
		}
		channels = wrapped.Channels
	}
	rows := make([]store.PublishChannelRow, 0, len(channels))
	for _, c := range channels {
		rows = append(rows, store.PublishChannelRow{ID: c.ID, Type: c.Type, Name: c.Name,
			Enabled: c.Enabled, Endpoint: c.Endpoint, Template: c.Template})
	}
	if err := a.store.ReplacePublishChannels(rows); err != nil {
		log.Printf("[httpapi] 渠道配置保存失败: %v", err)
		writeErr(w, errs.New(errs.DATABASE_ERROR, "渠道配置保存失败（DATABASE_ERROR）"))
		return
	}
	a.getChannels(w, r)
}

// ---------- stations ----------

// stationDTO 组装 MonitoringStation（含当前水位/趋势/预警态/阈值）。
func (a *API) stationDTO(s store.StationRow, levels []store.AlertLevelRow, withStats bool) StationDTO {
	dto := StationDTO{
		StationID: s.StationID, StationCode: s.StationCode, StationName: s.StationName,
		Location: s.Location, Kind: s.Kind, Enabled: s.Enabled,
		Longitude: s.Longitude, Latitude: s.Latitude, Trend: "stable",
		BaseLevel: s.BaseLevel, ResponseK: s.ResponseK,
	}
	thresholds := map[string]float64{}
	for _, l := range levels {
		thresholds[l.LevelKey] = l.WaterLevelThreshold
	}
	dto.Thresholds = thresholds

	now := time.Now()
	if latest, err := a.store.LatestObservation(s.StationID); err == nil && latest != nil {
		lvl := latest.Level
		dto.CurrentLevel = lvl
		ts := time.Unix(latest.Ts, 0)
		dto.CurrentTs = strPtr(ts.Format(time.RFC3339))
		age := math.Max(0, now.Sub(ts).Minutes())
		dto.DataAgeMin = &age
		// 趋势：近 1h（12 步）水位斜率
		if rows, err := a.store.ReadObservations(s.StationID, now.Add(-time.Hour), now); err == nil && len(rows) >= 2 {
			first, last := rows[0], rows[len(rows)-1]
			if first.Level != nil && last.Level != nil {
				d := *last.Level - *first.Level
				switch {
				case d > 0.005:
					dto.Trend = "rising"
				case d < -0.005:
					dto.Trend = "falling"
				}
			}
		}
	}
	rankOf := map[string]store.AlertLevelRow{}
	for _, l := range levels {
		rankOf[l.LevelKey] = l
	}
	if actives, err := a.store.ActiveAlertsForStation(s.StationID); err == nil && len(actives) > 0 {
		best := actives[0]
		var bestLvl store.AlertLevelRow
		has := false
		for _, al := range actives {
			l, ok := rankOf[al.Level]
			if ok && (!has || l.Rank > bestLvl.Rank) {
				best, bestLvl, has = al, l, true
			}
		}
		if has {
			dto.AlertID = &best.AlertID
			dto.AlertLevel = &bestLvl.Rank
			dto.AlertLevelName = strPtr(bestLvl.Name)
			dto.AlertLevelColor = strPtr(bestLvl.Color)
			dto.AlertReason = best.Reason
			dto.IsReference = best.IsReference
			dto.LeadMinutesAdvantage = best.LeadMinutesAdvantage
		}
	}
	if withStats {
		stats := a.stationAlertStats(s.StationID, rankOf)
		dto.AlertStats = &stats
	}
	return dto
}

func (a *API) stationAlertStats(stationID int64, rankOf map[string]store.AlertLevelRow) StationAlertStats {
	st := StationAlertStats{ByLevel: map[string]int{}}
	rows, total, _ := a.store.ListAlerts(nil, nil, &stationID, 1, 10000)
	st.Total = total
	for _, al := range rows {
		st.ByLevel[al.Level]++
		if al.IsReference {
			st.Reference++
		}
		if al.Status == "active" || al.Status == "confirmed" || al.Status == "published" {
			st.Active++
		}
	}
	_ = rankOf
	return st
}

func (a *API) listStations(w http.ResponseWriter, r *http.Request) {
	levels, _ := a.store.EnabledAlertLevels()
	rows, err := a.store.ListStations(false)
	if err != nil {
		writeErr(w, err)
		return
	}
	out := make([]StationDTO, 0, len(rows))
	for _, s := range rows {
		out = append(out, a.stationDTO(s, levels, false))
	}
	writeOK(w, out)
}

func (a *API) getStation(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	s, err := a.store.GetStation(id)
	if err != nil {
		writeErr(w, errs.New(errs.STATION_NOT_FOUND, "监测点不存在（STATION_NOT_FOUND）"))
		return
	}
	levels, _ := a.store.EnabledAlertLevels()
	writeOK(w, a.stationDTO(*s, levels, true))
}

func (a *API) createStation(w http.ResponseWriter, r *http.Request) {
	var body struct {
		StationCode string   `json:"stationCode"`
		StationName string   `json:"stationName"`
		Location    *string  `json:"location"`
		Kind        *string  `json:"kind"`
		BaseLevel   *float64 `json:"baseLevel"`
		ResponseK   *float64 `json:"responseK"`
		Longitude   *float64 `json:"longitude"`
		Latitude    *float64 `json:"latitude"`
		Enabled     *bool    `json:"enabled"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	if body.StationCode == "" || body.StationName == "" {
		writeErr(w, errs.New(errs.PARAM_INVALID, "stationCode/stationName 必填（PARAM_INVALID）"))
		return
	}
	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	id, err := a.store.CreateStation(&store.StationRow{
		StationCode: body.StationCode, StationName: body.StationName,
		Location: body.Location, Kind: body.Kind, BaseLevel: body.BaseLevel,
		ResponseK: body.ResponseK, Longitude: body.Longitude, Latitude: body.Latitude,
		Enabled: enabled,
	})
	if err != nil {
		writeErr(w, errs.New(errs.DATABASE_ERROR, "监测点创建失败（DATABASE_ERROR）"))
		return
	}
	s, _ := a.store.GetStation(id)
	levels, _ := a.store.EnabledAlertLevels()
	writeOK(w, a.stationDTO(*s, levels, true))
}

func (a *API) updateStation(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, err := a.store.GetStation(id); err != nil {
		writeErr(w, errs.New(errs.STATION_NOT_FOUND, "监测点不存在（STATION_NOT_FOUND）"))
		return
	}
	var body map[string]any
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	fields := map[string]any{}
	allowed := map[string]string{
		"stationName": "station_name", "location": "location", "kind": "kind",
		"baseLevel": "base_level", "responseK": "response_k",
		"longitude": "longitude", "latitude": "latitude", "enabled": "enabled",
	}
	for k, col := range allowed {
		if v, ok := body[k]; ok {
			fields[col] = v
		}
	}
	if err := a.store.UpdateStation(id, fields); err != nil {
		writeErr(w, errs.New(errs.DATABASE_ERROR, "监测点更新失败（DATABASE_ERROR）"))
		return
	}
	s, _ := a.store.GetStation(id)
	levels, _ := a.store.EnabledAlertLevels()
	writeOK(w, a.stationDTO(*s, levels, true))
}

func (a *API) deleteStation(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, err := a.store.GetStation(id); err != nil {
		writeErr(w, errs.New(errs.STATION_NOT_FOUND, "监测点不存在（STATION_NOT_FOUND）"))
		return
	}
	if err := a.store.DeleteStation(id); err != nil {
		writeErr(w, errs.New(errs.DATABASE_ERROR, "监测点删除失败（DATABASE_ERROR）"))
		return
	}
	writeOK(w, map[string]any{"deleted": true})
}

func (a *API) stationSeries(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	s, err := a.store.GetStation(id)
	if err != nil {
		writeErr(w, errs.New(errs.STATION_NOT_FOUND, "监测点不存在（STATION_NOT_FOUND）"))
		return
	}
	hours := queryInt(r, "hours", 24)
	if hours <= 0 || hours > 720 {
		hours = 24
	}
	rows, err := a.store.ReadObservations(id, time.Now().Add(-time.Duration(hours)*time.Hour), time.Now())
	if err != nil {
		writeErr(w, err)
		return
	}
	levels, _ := a.store.EnabledAlertLevels()
	thresholds := map[string]float64{}
	for _, l := range levels {
		thresholds[l.LevelKey] = l.WaterLevelThreshold
	}
	pts := make([]SeriesPointDTO, 0, len(rows))
	for _, o := range rows {
		rain := 0.0
		if o.RainObserved != nil {
			rain = *o.RainObserved
		}
		pts = append(pts, SeriesPointDTO{
			Ts: time.Unix(o.Ts, 0).Format(time.RFC3339), Level: o.Level, RainObserved: rain,
		})
	}
	writeOK(w, SeriesDTO{
		StationID: id, StationCode: s.StationCode,
		StepMinutes: a.cfg.Forecast.StepMinutes, Thresholds: thresholds, Points: pts,
	})
}

// ---------- forecasts ----------

// decisionDTO DB 决策行 → DTO。
func decisionDTO(d *store.DecisionRow) *DecisionDTO {
	if d == nil {
		return nil
	}
	fw := FusionWeightsDTO{}
	if d.FusionWeights != nil {
		_ = json.Unmarshal([]byte(*d.FusionWeights), &fw)
	}
	alpha, ci := 0.0, 0.0
	if d.RevisionAlpha != nil {
		alpha = *d.RevisionAlpha
	}
	if d.CiScale != nil {
		ci = *d.CiScale
	}
	degraded := d.Degraded != nil && *d.Degraded
	reason := ""
	if d.Reason != nil {
		reason = *d.Reason
	}
	return &DecisionDTO{
		SelectedModel: d.SelectedModel, FusionWeights: fw, RevisionAlpha: alpha,
		CiScale: ci, Degraded: degraded, Reason: reason,
	}
}

// revisionDTO 预测记录 → ForecastRevision DTO（含决策/预警富化）。
func (a *API) revisionDTO(f store.ForecastRow, withDetail bool) ForecastRevisionDTO {
	stationCode := ""
	if s, err := a.store.GetStation(f.StationID); err == nil {
		stationCode = s.StationCode
	}
	pts, _ := a.store.GetForecastPoints(f.ForecastID)
	pointDTOs := make([]ForecastPointDTO, 0, len(pts))
	for _, p := range pts {
		rev := 0.0
		if p.Revision != nil {
			rev = *p.Revision
		}
		lower, upper := 0.0, 0.0
		if p.LowerBound != nil {
			lower = *p.LowerBound
		}
		if p.UpperBound != nil {
			upper = *p.UpperBound
		}
		pointDTOs = append(pointDTOs, ForecastPointDTO{
			Time: time.Unix(p.TargetTime, 0).Format(time.RFC3339),
			WaterLevel: p.PredLevel, ConfidenceLow: lower, ConfidenceHigh: upper,
			LevelRaw: p.PredLevelRaw, Revision: rev,
		})
	}
	dto := ForecastRevisionDTO{
		ID:          fmt.Sprintf("R-%s-%06d", time.Unix(f.PredictTime, 0).Format("20060102"), f.ForecastID),
		StationID:   f.StationID, StationCode: stationCode, Lead: f.LeadHours,
		GeneratedAt: time.Unix(f.PredictTime, 0).Format(time.RFC3339),
		PredictTime: time.Unix(f.PredictTime, 0).Format(time.RFC3339),
		ModelVersion: f.ModelType, Points: pointDTOs, Remarks: f.Remark,
		ForecastID: f.ForecastID, Degraded: f.Degraded,
		Rmse: f.Rmse, Mae: f.Mae,
	}
	if f.PeakLevel != nil {
		dto.PeakLevel = *f.PeakLevel
	}
	if f.PeakTime != nil {
		dto.PeakTime = time.Unix(*f.PeakTime, 0).Format(time.RFC3339)
	}
	// 关联预警 → triggeredAlertLevel
	if al, err := a.store.GetAlertByForecast(f.ForecastID); err == nil && al != nil {
		levels, _ := a.store.EnabledAlertLevels()
		for _, l := range levels {
			if l.LevelKey == al.Level {
				rank := l.Rank
				dto.TriggeredAlertLevel = &rank
				break
			}
		}
		if withDetail {
			dto.Alert = alertBriefDTO(al, levels)
		}
	}
	if withDetail {
		if d, err := a.store.GetDecision(f.ForecastID); err == nil {
			dto.Decision = decisionDTO(d)
		}
	}
	return dto
}

func alertBriefDTO(al *store.AlertRow, levels []store.AlertLevelRow) *AlertBriefDTO {
	rank := 0
	for _, lv := range levels {
		if lv.LevelKey == al.Level {
			rank = lv.Rank
			break
		}
	}
	dto := &AlertBriefDTO{
		AlertID: al.AlertID, Level: rank, LevelKey: al.Level, Reason: al.Reason,
		IsReference: al.IsReference, LeadMinutesAdvantage: al.LeadMinutesAdvantage,
		Status: al.Status,
	}
	return dto
}

func (a *API) stationForecasts(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, err := a.store.GetStation(id); err != nil {
		writeErr(w, errs.New(errs.STATION_NOT_FOUND, "监测点不存在（STATION_NOT_FOUND）"))
		return
	}
	var leadPtr *int
	if v := queryStr(r, "lead"); v != nil {
		var lv int
		if _, err := fmt.Sscanf(*v, "%d", &lv); err == nil {
			leadPtr = &lv
		}
	}
	limit := queryInt(r, "limit", 20)
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	rows, _, err := a.store.ListForecastsForStation(id, leadPtr, 1, limit)
	if err != nil {
		writeErr(w, err)
		return
	}
	out := make([]ForecastRevisionDTO, 0, len(rows))
	for _, f := range rows {
		out = append(out, a.revisionDTO(f, false))
	}
	writeOK(w, out)
}

func (a *API) stationPredict(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var body struct {
		LeadHours int    `json:"leadHours"`
		ModelID   *int64 `json:"modelId"`
	}
	_ = decodeBody(r, &body) // 空 body → 默认预见期
	if body.LeadHours == 0 {
		body.LeadHours = a.cfg.Forecast.LeadHours[0]
	}
	res, berr := a.fc.RunPrediction(id, body.LeadHours, body.ModelID, time.Now())
	if berr != nil {
		writeErr(w, berr)
		return
	}
	f, _ := a.store.GetForecast(res.ForecastID)
	dto := a.revisionDTO(*f, true)
	if res.Decision != nil {
		dto.Decision = &DecisionDTO{
			SelectedModel: res.Decision.SelectedModel,
			FusionWeights: FusionWeightsDTO(res.Decision.FusionWeights),
			RevisionAlpha: res.Decision.RevisionAlpha, CiScale: res.Decision.CiScale,
			Degraded: res.Decision.Degraded, Reason: res.Decision.Reason,
		}
	}
	if res.Alert != nil {
		levels, _ := a.store.EnabledAlertLevels()
		dto.Alert = alertBriefDTO(res.Alert, levels)
	}
	dto.ConfidenceInterval = ConfidenceInterval{Lower: res.ConfidenceLower, Upper: res.ConfidenceUpper}
	writeOK(w, dto)
}

func (a *API) forecastComparison(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	f, err := a.store.GetForecast(id)
	if err != nil {
		writeErr(w, errs.New(errs.RESOURCE_NOT_FOUND, "预测记录不存在（RESOURCE_NOT_FOUND）"))
		return
	}
	pts, _ := a.store.GetForecastPoints(id)
	actual := []ActualPointDTO{}
	hit, n := 0, 0
	for _, p := range pts {
		if p.ActualLevel != nil {
			n++
			actual = append(actual, ActualPointDTO{
				Time: time.Unix(p.TargetTime, 0).Format(time.RFC3339), Level: p.ActualLevel,
			})
			lo, hi := 0.0, 0.0
			if p.LowerBound != nil {
				lo = *p.LowerBound
			}
			if p.UpperBound != nil {
				hi = *p.UpperBound
			}
			if *p.ActualLevel >= lo && *p.ActualLevel <= hi {
				hit++
			}
		}
	}
	hitRate := 0.0
	if n > 0 {
		hitRate = forecast.RoundN(float64(hit)/float64(n), 4)
	}
	mae, rmse := 0.0, 0.0
	if f.Mae != nil {
		mae = *f.Mae
	}
	if f.Rmse != nil {
		rmse = *f.Rmse
	}
	writeOK(w, ComparisonDTO{
		Forecast: a.revisionDTO(*f, true),
		Actual:   actual,
		Metrics: ComparisonMetricsDTO{Mae: mae, Rmse: rmse, HitRate: hitRate, SampleCount: n},
	})
}

func (a *API) forecastDecision(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, err := a.store.GetForecast(id); err != nil {
		writeErr(w, errs.New(errs.RESOURCE_NOT_FOUND, "预测记录不存在（RESOURCE_NOT_FOUND）"))
		return
	}
	d, err := a.store.GetDecision(id)
	if err != nil || d == nil {
		writeErr(w, errs.New(errs.RESOURCE_NOT_FOUND, "该预测无决策记录（RESOURCE_NOT_FOUND）"))
		return
	}
	writeOK(w, decisionDTO(d))
}

func strPtr(s string) *string { return &s }

var _ = chi.URLParam
var _ agent.SourceQuality // 保持 agent 包引用
