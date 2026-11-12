// Package httpapi P1 AI 能力 HTTP 处理器。
package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"waterlog/backend/internal/analysis"
	"waterlog/backend/internal/attribution"
	"waterlog/backend/internal/errs"
)

// ---------- Attribution ----------

// GetForecastAttribution GET /api/v1/forecasts/{id}/attribution
func (a *API) GetForecastAttribution(w http.ResponseWriter, r *http.Request) {
	fid, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}

	// 优先读缓存
	cached, err := a.store.GetAttributionByForecast(fid)
	if err != nil {
		writeErr(w, err)
		return
	}
	if cached != nil {
		var factors []attribution.AttributionFactor
		var modelInfo attribution.ModelInfo
		_ = json.Unmarshal([]byte(cached.FactorsJSON), &factors)
		_ = json.Unmarshal([]byte(cached.ModelInfoJSON), &modelInfo)
		writeOK(w, map[string]any{
			"forecastId":     cached.ForecastID,
			"stationId":      cached.StationID,
			"stationCode":    cached.StationCode,
			"leadHours":      cached.LeadHours,
			"baseLevel":      cached.BaseLevel,
			"predictedLevel": cached.PredictedLevel,
			"peakTime":       cached.PeakTime,
			"factors":        factors,
			"modelInfo":      modelInfo,
			"summary":        cached.Summary,
			"cached":         true,
		})
		return
	}

	// 实时计算
	attrSvc := attribution.NewService(a.store)
	idxStr := r.URL.Query().Get("pointIndex")
	var idx *int
	if idxStr != "" {
		if n, err := strconv.Atoi(idxStr); err == nil {
			idx = &n
		}
	}
	res, berr := attrSvc.Compute(fid, idx)
	if berr != nil {
		writeErr(w, berr)
		return
	}

	// 异步缓存（不阻塞响应）
	go func() {
		factorsJSON, _ := json.Marshal(res.Factors)
		modelJSON, _ := json.Marshal(res.ModelInfo)
		_ = a.store.SaveAttribution(res.ForecastID, res.StationID, res.StationCode, res.LeadHours,
			res.BaseLevel, res.PredictedLevel, res.PeakTime.Unix(),
			string(factorsJSON), string(modelJSON), res.Summary)
	}()

	writeOK(w, res)
}

// ---------- Analysis Report ----------

type generateReportReq struct {
	StationID  int64  `json:"stationId"`
	AlertID    *int64 `json:"alertId,omitempty"`
	ForecastID *int64 `json:"forecastId,omitempty"`
}

// PostAnalysisReport POST /api/v1/analysis/report
func (a *API) PostAnalysisReport(w http.ResponseWriter, r *http.Request) {
	var req generateReportReq
	if err := decodeBody(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	if req.StationID <= 0 {
		writeErr(w, errs.New(errs.PARAM_INVALID, "stationId 必填（PARAM_INVALID）"))
		return
	}

	ctx := r.Context()
	res, err := a.generateAnalysisReport(ctx, req)
	if err != nil {
		writeErr(w, err)
		return
	}

	writeOK(w, res)
}

func (a *API) generateAnalysisReport(ctx context.Context, req generateReportReq) (*analysis.ReportResult, error) {
	station, err := a.store.GetStation(req.StationID)
	if err != nil || station == nil {
		return nil, errs.New(errs.STATION_NOT_FOUND, "监测点不存在（STATION_NOT_FOUND）")
	}

	// 构建上下文
	rc := analysis.ReportContext{
		StationID:   station.StationID,
		StationCode: station.StationCode,
		StationName: station.StationName,
	}
	if station.Location != nil {
		rc.Location = *station.Location
	}
	if station.BaseLevel != nil {
		// current level 近似用基线
		rc.CurrentLevel = *station.BaseLevel
	}
	if station.ThresholdBlue != nil {
		rc.ThresholdBlue = *station.ThresholdBlue
	}
	if station.ThresholdYellow != nil {
		rc.ThresholdYellow = *station.ThresholdYellow
	}
	if station.ThresholdOrange != nil {
		rc.ThresholdOrange = *station.ThresholdOrange
	}
	if station.ThresholdRed != nil {
		rc.ThresholdRed = *station.ThresholdRed
	}

	// 最新观测
	obs, _ := a.store.LatestObservation(station.StationID)
	if obs != nil && obs.Level != nil {
		rc.CurrentLevel = *obs.Level
	}

	// 关联预测
	if req.ForecastID != nil && *req.ForecastID > 0 {
		f, _ := a.store.GetForecast(*req.ForecastID)
		if f != nil {
			rc.ForecastID = f.ForecastID
			rc.LeadHours = f.LeadHours
			if f.PeakLevel != nil {
				rc.ForecastPeak = *f.PeakLevel
			}
			if f.PeakTime != nil {
				rc.ForecastTime = formatUnixTime(*f.PeakTime)
			}
			// 决策信息
			d, _ := a.store.GetDecision(f.ForecastID)
			if d != nil {
				rc.ModelSelected = d.SelectedModel
				if d.Degraded != nil {
					rc.Degraded = *d.Degraded
				}
			}
		}
	}

	// 关联预警
	if req.AlertID != nil && *req.AlertID > 0 {
		alert, _ := a.store.GetAlert(*req.AlertID)
		if alert != nil {
			rc.AlertLevel = alert.Level
			if alert.PeakLevel != nil {
				rc.ForecastPeak = *alert.PeakLevel
			}
			if alert.Trend != nil && *alert.Trend > 0.01 {
				rc.Trend = "上升"
			} else if alert.Trend != nil && *alert.Trend < -0.01 {
				rc.Trend = "下降"
			} else {
				rc.Trend = "平稳"
			}
		}
	}

	// 降雨统计（近6h）
	if rc.ForecastID > 0 {
		pts, _ := a.store.GetForecastPoints(rc.ForecastID)
		var rainSum float64
		for _, p := range pts {
			// 这里简化：用预测点的 lower_bound 近似降雨贡献
			if p.LowerBound != nil {
				rainSum += *p.LowerBound * 0.1
			}
		}
		rc.RainLast6h = rainSum
	}

	// 调用分析服务生成报告
	res, err := a.analysis.Generate(ctx, rc)
	if err != nil {
		return nil, err
	}
	res.AlertID = req.AlertID
	res.ForecastID = req.ForecastID

	// 落库
	reportID, err := a.store.SaveAnalysisReport(res.StationID, res.StationCode, res.AlertID, res.ForecastID,
		res.Situation, string(res.RiskLevel), res.Suggestions, res.WatchPoints,
		res.Confidence, res.Provider, res.GeneratedAt.Unix())
	if err == nil {
		res.ReportID = reportID
	}
	return res, nil
}

// ListAnalysisReports GET /api/v1/analysis/reports
func (a *API) ListAnalysisReports(w http.ResponseWriter, r *http.Request) {
	stationID := queryInt(r, "stationId", 0)
	page := queryInt(r, "page", 1)
	pageSize := queryInt(r, "pageSize", 20)
	if pageSize > 100 {
		pageSize = 100
	}

	var sid *int64
	if stationID > 0 {
		s := int64(stationID)
		sid = &s
	}

	rows, total, err := a.store.ListAnalysisReports(sid, page, pageSize)
	if err != nil {
		writeErr(w, err)
		return
	}

	var list []map[string]any
	for _, row := range rows {
		var suggestions, watchPoints []string
		_ = json.Unmarshal([]byte(row.SuggestionsJSON), &suggestions)
		_ = json.Unmarshal([]byte(row.WatchPointsJSON), &watchPoints)
		list = append(list, map[string]any{
			"reportId":    row.ReportID,
			"stationId":   row.StationID,
			"stationCode": row.StationCode,
			"alertId":     row.AlertID,
			"forecastId":  row.ForecastID,
			"situation":   row.Situation,
			"riskLevel":   row.RiskLevel,
			"suggestions": suggestions,
			"watchPoints": watchPoints,
			"confidence":  row.Confidence,
			"provider":    row.Provider,
			"generatedAt": row.GeneratedAt,
		})
	}

	writeOK(w, map[string]any{
		"list":     list,
		"total":    total,
		"page":     page,
		"pageSize": pageSize,
	})
}

// GetAnalysisReport GET /api/v1/analysis/reports/{id}
func (a *API) GetAnalysisReport(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	row, err := a.store.GetAnalysisReport(id)
	if err != nil {
		writeErr(w, err)
		return
	}
	if row == nil {
		writeErr(w, errs.New(errs.RESOURCE_NOT_FOUND, "报告不存在（RESOURCE_NOT_FOUND）"))
		return
	}
	var suggestions, watchPoints []string
	_ = json.Unmarshal([]byte(row.SuggestionsJSON), &suggestions)
	_ = json.Unmarshal([]byte(row.WatchPointsJSON), &watchPoints)
	writeOK(w, map[string]any{
		"reportId":    row.ReportID,
		"stationId":   row.StationID,
		"stationCode": row.StationCode,
		"alertId":     row.AlertID,
		"forecastId":  row.ForecastID,
		"situation":   row.Situation,
		"riskLevel":   row.RiskLevel,
		"suggestions": suggestions,
		"watchPoints": watchPoints,
		"confidence":  row.Confidence,
		"provider":    row.Provider,
		"generatedAt": row.GeneratedAt,
	})
}

func formatUnixTime(ts int64) string {
	if ts <= 0 {
		return ""
	}
	return time.Unix(ts, 0).Format("2006-01-02 15:04")
}
