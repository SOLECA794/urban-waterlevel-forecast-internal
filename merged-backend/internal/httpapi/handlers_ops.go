// 运维 / 模型 / 校准 / 健康 / SSE / 模拟事件 handler。
package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"waterlog/backend/internal/errs"
	"waterlog/backend/internal/store"
)

// 渠道 id → 名称/编码（种子固定：1 站内通知 2 信息大屏 3 短信）。
var publishChannelNames = []struct {
	id   int64
	name string
}{
	{id: 1, name: "站内通知"},
	{id: 2, name: "信息大屏"},
	{id: 3, name: "短信"},
}

func channelCodeOf(id int64) string {
	switch id {
	case 1:
		return "IN_APP"
	case 2:
		return "INFO_SCREEN"
	case 3:
		return "SMS"
	}
	return "UNKNOWN"
}

func pad6(n int64) string {
	return fmt.Sprintf("%06d", n)
}

// ---------- 数据源 ----------

// listDatasources GET /datasources。
func (a *API) listDatasources(w http.ResponseWriter, r *http.Request) {
	rows, err := a.store.Datasources()
	if err != nil {
		writeErr(w, err)
		return
	}
	ageMin := a.gen.FreshnessAgeMinutes(time.Now())
	status, detail := a.src.Detail(ageMin)
	items := []DatasourceDTO{}
	for _, d := range rows {
		schema := []any{}
		if d.SchemaJSON != nil {
			_ = json.Unmarshal([]byte(*d.SchemaJSON), &schema)
		}
		st, de := d.Status, ""
		if d.Type == "simulated_water_level" || d.Type == "simulated" {
			st, de = status, detail
		}
		items = append(items, DatasourceDTO{
			ID: d.ID, Type: d.Type, Name: d.Name, Status: st,
			Endpoint: d.Endpoint, RefreshIntervalSec: d.RefreshIntervalSec,
			Quality: QualityDTO{SuccessRate: d.QualitySuccessRate,
				MissingRate: d.QualityMissingRate, AvgLatency: d.QualityAvgLatency},
			Schema: schema, Enabled: d.Enabled, LastError: &de,
		})
	}
	writeOK(w, items)
}

// updateDatasource PUT /datasources/{id}。
func (a *API) updateDatasource(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var body struct {
		Enabled           *bool   `json:"enabled"`
		Endpoint          *string `json:"endpoint"`
		RefreshIntervalSec *int   `json:"refreshIntervalSec"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	fields := map[string]any{"updated_at": time.Now().Unix()}
	if body.Enabled != nil {
		fields["enabled"] = *body.Enabled
	}
	if body.Endpoint != nil {
		fields["endpoint"] = *body.Endpoint
	}
	if body.RefreshIntervalSec != nil {
		if *body.RefreshIntervalSec < 5 {
			writeErr(w, errs.New(errs.PARAM_INVALID, "刷新间隔不得低于 5 秒（PARAM_INVALID）"))
			return
		}
		fields["refresh_interval_sec"] = *body.RefreshIntervalSec
	}
	if err := a.store.UpdateDatasource(id, fields); err != nil {
		writeErr(w, err)
		return
	}
	rows, _ := a.store.Datasources()
	for _, d := range rows {
		if d.ID == id {
			items := []DatasourceDTO{}
			schema := []any{}
			if d.SchemaJSON != nil {
				_ = json.Unmarshal([]byte(*d.SchemaJSON), &schema)
			}
			items = append(items, DatasourceDTO{ID: d.ID, Type: d.Type, Name: d.Name,
				Status: d.Status, Endpoint: d.Endpoint, RefreshIntervalSec: d.RefreshIntervalSec,
				Quality: QualityDTO{SuccessRate: d.QualitySuccessRate, MissingRate: d.QualityMissingRate,
					AvgLatency: d.QualityAvgLatency},
				Schema: schema, Enabled: d.Enabled})
			writeOK(w, items[0])
			return
		}
	}
	writeErr(w, errs.New(errs.RESOURCE_NOT_FOUND, "数据源不存在（RESOURCE_NOT_FOUND）"))
}

// ---------- 校准 / 模型 ----------

func parseJSONAny(s *string) any {
	if s == nil || *s == "" {
		return nil
	}
	var v any
	if err := json.Unmarshal([]byte(*s), &v); err != nil {
		return *s
	}
	return v
}

// listCalibrations GET /calibrations。
func (a *API) listCalibrations(w http.ResponseWriter, r *http.Request) {
	page := maxInt(queryInt(r, "page", 1), 1)
	pageSize := clampInt(queryInt(r, "pageSize", 20), 1, 100)
	rows, total, err := a.store.ListCalibrations(page, pageSize)
	if err != nil {
		writeErr(w, err)
		return
	}
	items := []CalibrationDTO{}
	for _, c := range rows {
		items = append(items, CalibrationDTO{
			ID: c.ID, Type: c.Type, Target: c.Target,
			Before: parseJSONAny(c.BeforeJSON), After: parseJSONAny(c.AfterJSON),
			Preview: parseJSONAny(c.PreviewJSON), Status: c.Status,
			ExecutedBy: c.ExecutedBy, Note: c.Note, CreatedAt: fmtTime(c.CreatedAt),
		})
	}
	writeOK(w, PageDTO{Items: items, Total: total, Page: page, PageSize: pageSize})
}

// createCalibration POST /calibrations（retrain 占位任务）。
func (a *API) createCalibration(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Type      string  `json:"type"`
		StationID *int64  `json:"stationId"`
		BaseModelID *int64 `json:"baseModelId"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	if body.Type == "" {
		body.Type = "retrain"
	}
	if body.Type != "retrain" {
		writeErr(w, errs.New(errs.PARAM_INVALID, "type 仅支持 retrain（参数校准请用 /calibrate-params）"))
		return
	}
	res, berr := a.calib.CreateRetrainTask(body.StationID, body.BaseModelID)
	if berr != nil {
		writeErr(w, berr)
		return
	}
	writeOK(w, res)
}

// listModels GET /models。
func (a *API) listModels(w http.ResponseWriter, r *http.Request) {
	rows, err := a.store.ListModels()
	if err != nil {
		writeErr(w, err)
		return
	}
	items := []ModelDTO{}
	for _, m := range rows {
		items = append(items, ModelDTO{
			ModelID: m.ModelID, ModelName: m.ModelName, Version: m.Version,
			ModelType: m.ModelType, Active: m.Active, Rmse: m.Rmse, Mae: m.Mae,
			ModelFile: m.ModelFile, AlgorithmConfig: parseJSONAny(m.AlgorithmConfig),
			Activatable: !m.Active,
		})
	}
	writeOK(w, items)
}

// activateModel POST /models/{id}/activate。
func (a *API) activateModel(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, err := a.store.GetModel(id); err != nil {
		writeErr(w, errs.New(errs.RESOURCE_NOT_FOUND, "模型不存在（RESOURCE_NOT_FOUND）"))
		return
	}
	if err := a.store.ActivateModel(id); err != nil {
		writeErr(w, err)
		return
	}
	m, _ := a.store.GetModel(id)
	writeOK(w, ModelDTO{ModelID: m.ModelID, ModelName: m.ModelName, Version: m.Version,
		ModelType: m.ModelType, Active: m.Active, Rmse: m.Rmse, Mae: m.Mae,
		ModelFile: m.ModelFile, AlgorithmConfig: parseJSONAny(m.AlgorithmConfig), Activatable: false})
}

// calibrateParams POST /calibrate-params。
func (a *API) calibrateParams(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ModelID   int64 `json:"modelId"`
		StationID int64 `json:"stationId"`
		Hours     int   `json:"hours"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	if body.Hours <= 0 {
		body.Hours = 48
	}
	if body.Hours > 720 {
		writeErr(w, errs.New(errs.PARAM_INVALID, "hours 超出范围（1-720）"))
		return
	}
	res, berr := a.calib.CalibrateParams(body.ModelID, body.StationID, body.Hours, time.Now())
	if berr != nil {
		writeErr(w, berr)
		return
	}
	writeOK(w, res)
}

// ---------- 健康 ----------

func (a *API) health(w http.ResponseWriter, r *http.Request) {
	writeOK(w, map[string]any{"status": "ok", "time": time.Now().Format(time.RFC3339)})
}

func (a *API) healthDetail(w http.ResponseWriter, r *http.Request) {
	ageMin := a.gen.FreshnessAgeMinutes(time.Now())
	status, detail := a.src.Detail(ageMin)
	ds := map[string]any{
		"status":     status,
		"detail":     detail,
		"dataAgeMin": ageMin,
	}
	model := map[string]any{}
	if m, err := a.store.GetActiveModel(); err == nil {
		model["modelId"] = m.ModelID
		model["modelName"] = m.ModelName
		model["modelType"] = m.ModelType
		model["version"] = m.Version
		model["status"] = "ready"
	}
	stations, _ := a.store.CountStations()
	forecasts, _ := a.store.CountForecasts()
	db := map[string]any{"status": "ok", "stations": stations, "forecasts": forecasts}
	writeOK(w, HealthDetailDTO{Status: "ok", Time: time.Now().Format(time.RFC3339),
		Datasource: ds, Model: model, Database: db, Scheduler: a.sched.Status()})
}

// ---------- SSE ----------

func (a *API) streamAlerts(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, errs.New(errs.INTERNAL_ERROR, "当前连接不支持流式响应"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	ch := a.bus.Subscribe()
	defer a.bus.Unsubscribe(ch)
	// 初始注释心跳。
	fmt.Fprintf(w, ": connected\n\n")
	fl.Flush()
	keepalive := time.NewTicker(20 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case payload, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "event: alert\ndata: %s\n\n", payload)
			fl.Flush()
		case <-keepalive.C:
			fmt.Fprintf(w, ": keepalive\n\n")
			fl.Flush()
		}
	}
}

// ---------- 模拟事件 ----------

func simEventDTO(e store.InjectedEventRow) SimEventDTO {
	return SimEventDTO{
		EventID: e.EventID, StationID: e.StationID, Intensity: e.Intensity,
		IntensityLabel: e.IntensityLabel, PeakMmPerStep: e.PeakMmPerStep,
		DurationMinutes: e.DurationMinutes, StartTs: fmtTime(e.StartTs),
		EndTs: fmtTime(e.EndTs), InjectedAt: fmtTime(e.InjectedAt),
	}
}

func (a *API) injectEvent(w http.ResponseWriter, r *http.Request) {
	var body struct {
		StationID int64  `json:"stationId"`
		Intensity string `json:"intensity"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	if body.StationID <= 0 {
		writeErr(w, errs.New(errs.PARAM_INVALID, "stationId 必填（PARAM_INVALID）"))
		return
	}
	switch body.Intensity {
	case "light", "moderate", "heavy", "extreme":
	default:
		writeErr(w, errs.New(errs.PARAM_INVALID, "intensity 仅支持 light/moderate/heavy/extreme"))
		return
	}
	ev, err := a.gen.InjectEvent(body.StationID, body.Intensity, time.Now())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, simEventDTO(*ev))
}

func (a *API) listEvents(w http.ResponseWriter, r *http.Request) {
	limit := clampInt(queryInt(r, "limit", 50), 1, 200)
	rows, err := a.store.ListInjectedEvents(limit)
	if err != nil {
		writeErr(w, err)
		return
	}
	items := []SimEventDTO{}
	for _, e := range rows {
		items = append(items, simEventDTO(e))
	}
	writeOK(w, items)
}
