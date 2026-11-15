package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
)

// ---------------------------------------------------------------- 预警读取

func (s *Server) listAlerts(w http.ResponseWriter, r *http.Request) {
	// 参数名两种写法都收：前端用 active=0/1，验收脚本用 active_only=true/false。
	// 曾经只认 active，脚本传 active_only=false 被静默忽略、默认按「只看活跃」过滤，
	// 结果已解除的事件怎么都查不到——参数名不一致的静默降级比报错更难查。
	activeOnly := true
	if v, ok := r.URL.Query()["active"]; ok {
		activeOnly = len(v) == 0 || (v[0] != "0" && v[0] != "false")
	}
	if v, ok := r.URL.Query()["active_only"]; ok {
		activeOnly = len(v) == 0 || (v[0] != "0" && v[0] != "false")
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 100
	}
	evs, err := s.svc.ListAlerts(activeOnly, limit)
	if err != nil {
		failErr(w, err)
		return
	}
	// total 是数据库里的真总数：前端页签要显示「预警 N」，
	// 数返回条数会数到 limit（100）上，看起来像「刚好一百条」。
	total, _ := s.svc.CountAlerts(activeOnly)
	writeJSON(w, http.StatusOK, map[string]any{"alerts": evs, "total": total})
}

// alertDetail 返回一条预警及其全部处置记录（派单、状态推进、备注）。
func (s *Server) alertDetail(w http.ResponseWriter, r *http.Request) {
	id, ok := s.alertID(w, r)
	if !ok {
		return
	}
	ev, notes, err := s.svc.AlertDetail(id)
	if err != nil {
		// store 层对「不存在」只给一句中文原因，这里按 404 处理
		fail(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"event": ev, "notes": notes})
}

// ---------------------------------------------------------------- 预警写入

func (s *Server) ackAlert(w http.ResponseWriter, r *http.Request) {
	id, ok := s.alertID(w, r)
	if !ok {
		return
	}
	out, err := s.svc.Ack(id)
	if err != nil {
		failErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) assignAlert(w http.ResponseWriter, r *http.Request) {
	id, ok := s.alertID(w, r)
	if !ok {
		return
	}
	var body struct {
		Assignee string `json:"assignee"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		fail(w, http.StatusBadRequest, "body 需为 JSON")
		return
	}
	out, err := s.svc.Assign(id, body.Assignee)
	if err != nil {
		failErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) setDisposition(w http.ResponseWriter, r *http.Request) {
	id, ok := s.alertID(w, r)
	if !ok {
		return
	}
	var body struct {
		Disposition string `json:"disposition"`
		Note        string `json:"note"`
		Author      string `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		fail(w, http.StatusBadRequest, "body 需为 JSON")
		return
	}
	out, err := s.svc.Advance(id, body.Disposition, body.Note, body.Author)
	if err != nil {
		failErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) addAlertNote(w http.ResponseWriter, r *http.Request) {
	id, ok := s.alertID(w, r)
	if !ok {
		return
	}
	var body struct {
		Text   string `json:"text"`
		Author string `json:"author"`
		Kind   string `json:"kind"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		fail(w, http.StatusBadRequest, "body 需为 JSON")
		return
	}
	out, err := s.svc.Note(id, body.Text, body.Author, body.Kind)
	if err != nil {
		failErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// alertID 解析路径里的预警 ID；失败时已经写好响应，调用方直接 return。
func (s *Server) alertID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		fail(w, http.StatusBadRequest, "bad id")
		return 0, false
	}
	return id, true
}
