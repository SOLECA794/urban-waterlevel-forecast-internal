// 预警中心 / 运维 / 健康检查 / SSE / 模拟事件 handler。
package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"waterlog/backend/internal/errs"
	"waterlog/backend/internal/store"
)

// alertEventDTO 预警事件富化（等级表 + 推理链 + 发布历史）。
func (a *API) alertEventDTO(al store.AlertRow, levels []store.AlertLevelRow,
	st *store.StationRow) AlertEventDTO {
	dto := AlertEventDTO{
		AlertID:           al.AlertID,
		StationID:         al.StationID,
		ForecastID:        al.ForecastID,
		LevelKey:          al.Level,
		Reason:            al.Reason,
		IsReference:       al.IsReference,
		PeakLevel:         al.PeakLevel,
		LeadHours:         al.LeadHours,
		Status:            al.Status,
		DurationMin:       al.DurationMin,
		Trend:             al.Trend,
		FalseReportReason: al.FalseReportReason,
		Reasoning:         []string{},
		PublishHistory:    []PublishHistoryDTO{},
	}
	if st != nil {
		dto.StationCode = st.StationCode
		dto.StationName = st.StationName
	}
	for _, lv := range levels {
		if lv.LevelKey == al.Level {
			dto.Level = lv.Rank
			dto.LevelName = lv.Name
			dto.LevelColor = lv.Color
			break
		}
	}
	if al.LeadMinutesAdvantage != nil {
		v := *al.LeadMinutesAdvantage
		dto.Lead = &v
	}
	dto.AlertTime = fmtTime(al.AlertTime)
	if al.PeakTime != nil {
		dto.PeakTime = strPtr(fmtTime(*al.PeakTime))
	}
	if al.ResolveTime != nil {
		dto.ResolveTime = strPtr(fmtTime(*al.ResolveTime))
	}
	// 推理链（reasoning）：原后端按等级命中 + 峰值 + 趕前量组织文案。
	if al.Reason != nil {
		dto.Reasoning = append(dto.Reasoning, *al.Reason)
	}
	if al.PeakLevel != nil {
		dto.Reasoning = append(dto.Reasoning, "峰值水位 "+trimF(*al.PeakLevel)+" m，达到 "+al.Level+" 阈值")
	}
	if al.LeadMinutesAdvantage != nil && *al.LeadMinutesAdvantage > 0 {
		dto.Reasoning = append(dto.Reasoning, "较实测溢出提前约 "+itoa(*al.LeadMinutesAdvantage)+" 分钟")
	}
	// 发布历史。
	if recs, err := a.store.PublishRecordsForAlerts([]int64{al.AlertID}); err == nil {
		if rs, ok := recs[al.AlertID]; ok {
			for _, rec := range rs {
				dto.PublishHistory = append(dto.PublishHistory, publishHistoryDTO(rec))
			}
		}
	}
	return dto
}

func publishHistoryDTO(rec store.PublishRecordRow) PublishHistoryDTO {
	ch := ""
	for _, c := range publishChannelNames {
		if c.id == rec.ChannelID {
			ch = c.name
		}
	}
	detail := ""
	if rec.Content != nil {
		detail = *rec.Content
	}
	return PublishHistoryDTO{
		RecordID:    "P-" + pad6(rec.RecordID),
		Channel:     ch,
		ChannelCode: channelCodeOf(rec.ChannelID),
		Status:      "simulated",
		Detail:      detail,
		PublishTime: fmtTime(rec.PublishedAt),
	}
}

// listAlerts GET /alerts。
func (a *API) listAlerts(w http.ResponseWriter, r *http.Request) {
	page := maxInt(queryInt(r, "page", 1), 1)
	pageSize := clampInt(queryInt(r, "pageSize", 20), 1, 100)
	rows, total, err := a.store.ListAlerts(queryStr(r, "status"), queryStr(r, "level"),
		queryStationID(r), page, pageSize)
	if err != nil {
		writeErr(w, err)
		return
	}
	levels, _ := a.store.AlertLevels()
	stations := map[int64]*store.StationRow{}
	items := []AlertEventDTO{}
	for _, al := range rows {
		st, ok := stations[al.StationID]
		if !ok {
			if s, err := a.store.GetStation(al.StationID); err == nil {
				st = s
			}
			stations[al.StationID] = st
		}
		items = append(items, a.alertEventDTO(al, levels, st))
	}
	writeOK(w, PageDTO{Items: items, Total: total, Page: page, PageSize: pageSize})
}

// alertStats GET /alerts/stats。
func (a *API) alertStats(w http.ResponseWriter, r *http.Request) {
	byStatus, byLevel, err := a.store.AlertStats()
	if err != nil {
		writeErr(w, err)
		return
	}
	levels, _ := a.store.AlertLevels()
	rankOf := map[string]int{}
	for _, lv := range levels {
		rankOf[lv.LevelKey] = lv.Rank
	}
	rows, _, err := a.store.ListAlerts(nil, nil, nil, 1, 100000)
	if err != nil {
		writeErr(w, err)
		return
	}
	midnight := time.Now().Truncate(24 * time.Hour)
	dto := AlertStatsDTO{
		TodayTotal:     0,
		EffectiveTotal: 0,
		ReferenceTotal: 0,
		ActiveTotal:    byStatus["active"],
		ByLevel:        map[string]int{},
	}
	maxRank := -1
	for _, al := range rows {
		if al.AlertTime >= midnight.Unix() {
			dto.TodayTotal++
		}
		if al.IsReference {
			dto.ReferenceTotal++
		}
		if al.Status != "false_report" {
			dto.EffectiveTotal++
			if rk, ok := rankOf[al.Level]; ok && rk > maxRank {
				maxRank = rk
				k := al.Level
				dto.MaxEffectiveLevel = &k
			}
		}
	}
	for k, v := range byLevel {
		dto.ByLevel[k] = v
	}
	writeOK(w, dto)
}

// alertConfirm POST /alerts/{id}/confirm。
func (a *API) alertConfirm(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	al, err := a.alert.ConfirmAlert(id)
	if err != nil {
		writeErr(w, err)
		return
	}
	a.writeAlertDetail(w, *al)
}

// alertResolve POST /alerts/{id}/resolve。
func (a *API) alertResolve(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	al, err := a.alert.ResolveAlert(id)
	if err != nil {
		writeErr(w, err)
		return
	}
	a.writeAlertDetail(w, *al)
}

// alertFalseReport POST /alerts/{id}/false-report。
func (a *API) alertFalseReport(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var body struct {
		FalseReportReason string `json:"falseReportReason"`
	}
	if r.Body != nil {
		if err := decodeBody(r, &body); err != nil {
			writeErr(w, err)
			return
		}
	}
	if body.FalseReportReason == "" {
		body.FalseReportReason = "人工判定为误报"
	}
	al, err := a.alert.FalseReportAlert(id, body.FalseReportReason)
	if err != nil {
		writeErr(w, err)
		return
	}
	a.writeAlertDetail(w, *al)
}

// alertPublish POST /alerts/{id}/publish。
func (a *API) alertPublish(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var body struct {
		Channels []string `json:"channels"`
		Operator string   `json:"operator"`
	}
	if r.Body != nil {
		if err := decodeBody(r, &body); err != nil {
			writeErr(w, err)
			return
		}
	}
	if len(body.Channels) == 0 {
		writeErr(w, errs.New(errs.PARAM_INVALID, "发布渠道不能为空（PARAM_INVALID）"))
		return
	}
	if body.Operator == "" {
		body.Operator = "operator"
	}
	_, berr := a.pub.PublishAlert(id, body.Channels, body.Operator)
	if berr != nil {
		writeErr(w, berr)
		return
	}
	al, _ := a.store.GetAlert(id)
	a.writeAlertDetail(w, *al)
}

// publishRecords GET /alerts/publish-records。
func (a *API) publishRecords(w http.ResponseWriter, r *http.Request) {
	page := maxInt(queryInt(r, "page", 1), 1)
	pageSize := clampInt(queryInt(r, "pageSize", 20), 1, 100)
	var alertID *int64
	if v := queryStr(r, "alertId"); v != nil {
		var id int64
		if err := json.Unmarshal([]byte(*v), &id); err == nil {
			alertID = &id
		}
	}
	total, items, err := a.pub.ListRecords(alertID, page, pageSize)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, PageDTO{Items: items, Total: total, Page: page, PageSize: pageSize})
}

// writeAlertDetail 输出富化预警详情（发布历史已由 alertEventDTO 从库内富化）。
func (a *API) writeAlertDetail(w http.ResponseWriter, al store.AlertRow) {
	levels, _ := a.store.AlertLevels()
	var station *store.StationRow
	if s2, err := a.store.GetStation(al.StationID); err == nil {
		station = s2
	}
	dto := a.alertEventDTO(al, levels, station)
	writeOK(w, dto)
}

// ---------- 小工具 ----------

func queryStationID(r *http.Request) *int64 {
	v := chi.URLParam(r, "id")
	if v == "" {
		v = r.URL.Query().Get("stationId")
	}
	if v == "" {
		return nil
	}
	var id int64
	if err := json.Unmarshal([]byte(v), &id); err != nil {
		return nil
	}
	return &id
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func trimF(f float64) string {
	b, _ := json.Marshal(f)
	return string(b)
}

func itoa(n int) string {
	return trimF(float64(n))
}

func str(m map[string]any, k string) string {
	if m == nil {
		return ""
	}
	if v, ok := m[k].(string); ok {
		return v
	}
	return ""
}
