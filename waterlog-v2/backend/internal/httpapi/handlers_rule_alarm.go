package httpapi

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"waterlog/v2/internal/model"
)

// ---------- 规则链 ----------

func (a *API) handleListChains(w http.ResponseWriter, r *http.Request) {
	list, err := a.repo.ListChains()
	if err != nil {
		writeErr(w, err)
		return
	}
	// 附带节点，前端可一次渲染
	for i := range list {
		nodes, err := a.repo.ListNodesByChain(list[i].ID)
		if err == nil {
			list[i].Nodes = nodes
		}
	}
	writeOK(w, list)
}

func (a *API) handleGetChain(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	c, err := a.repo.GetChain(id)
	if err != nil {
		writeErr(w, notFound("规则链不存在"))
		return
	}
	writeOK(w, c)
}

func (a *API) handleCreateChain(w http.ResponseWriter, r *http.Request) {
	var c model.RuleChain
	if err := decodeBody(r, &c); err != nil {
		writeErr(w, err)
		return
	}
	c.Name = strings.TrimSpace(c.Name)
	if c.Name == "" {
		writeErr(w, badRequest("规则链名称不能为空"))
		return
	}
	if err := a.repo.CreateChain(&c); err != nil {
		writeErr(w, err)
		return
	}
	a.repo.Audit("admin", "chain.create", c.Name, "")
	writeOK(w, c)
}

func (a *API) handleUpdateChain(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	cur, err := a.repo.GetChain(id)
	if err != nil {
		writeErr(w, notFound("规则链不存在"))
		return
	}
	var c model.RuleChain
	if err := decodeBody(r, &c); err != nil {
		writeErr(w, err)
		return
	}
	if c.Name != "" {
		cur.Name = c.Name
	}
	cur.Description = c.Description
	cur.Enabled = c.Enabled
	if err := a.repo.UpdateChain(cur); err != nil {
		writeErr(w, err)
		return
	}
	a.repo.Audit("admin", "chain.update", cur.Name, "")
	writeOK(w, cur)
}

func (a *API) handleDeleteChain(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	c, err := a.repo.GetChain(id)
	if err != nil {
		writeErr(w, notFound("规则链不存在"))
		return
	}
	if err := a.repo.DeleteChain(id); err != nil {
		writeErr(w, err)
		return
	}
	a.repo.Audit("admin", "chain.delete", c.Name, "")
	writeOK(w, map[string]any{"deleted": id})
}

// ---------- 规则节点 ----------

func (a *API) handleCreateNode(w http.ResponseWriter, r *http.Request) {
	chainID, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, err := a.repo.GetChain(chainID); err != nil {
		writeErr(w, notFound("规则链不存在"))
		return
	}
	var n model.RuleNode
	if err := decodeBody(r, &n); err != nil {
		writeErr(w, err)
		return
	}
	n.ChainID = chainID
	if n.Name == "" {
		n.Name = "未命名规则"
	}
	if err := n.Validate(); err != nil {
		writeErr(w, badRequest(err.Error()))
		return
	}
	if err := a.repo.CreateNode(&n); err != nil {
		writeErr(w, err)
		return
	}
	a.repo.Audit("admin", "node.create", n.Name, n.Metric)
	writeOK(w, n)
}

func (a *API) handleUpdateNode(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "nodeId")
	if err != nil {
		writeErr(w, err)
		return
	}
	cur, err := a.repo.GetNode(id)
	if err != nil {
		writeErr(w, notFound("规则节点不存在"))
		return
	}
	var n model.RuleNode
	if err := decodeBody(r, &n); err != nil {
		writeErr(w, err)
		return
	}
	if n.Name != "" {
		cur.Name = n.Name
	}
	cur.DeviceProfileID = n.DeviceProfileID
	if n.Metric != "" {
		cur.Metric = n.Metric
	}
	if n.Op != "" {
		cur.Op = n.Op
	}
	cur.Threshold = n.Threshold
	cur.DurationSec = n.DurationSec
	if n.LevelKey != "" {
		cur.LevelKey = n.LevelKey
	}
	if n.LevelRank > 0 {
		cur.LevelRank = n.LevelRank
	}
	if n.Severity != "" {
		cur.Severity = n.Severity
	}
	if n.ActionsList != nil {
		cur.ActionsList = n.ActionsList
	}
	if n.Priority > 0 {
		cur.Priority = n.Priority
	}
	cur.Enabled = n.Enabled
	if err := cur.Validate(); err != nil {
		writeErr(w, badRequest(err.Error()))
		return
	}
	if err := a.repo.UpdateNode(cur); err != nil {
		writeErr(w, err)
		return
	}
	a.repo.Audit("admin", "node.update", cur.Name, cur.Metric)
	writeOK(w, cur)
}

func (a *API) handleDeleteNode(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "nodeId")
	if err != nil {
		writeErr(w, err)
		return
	}
	n, err := a.repo.GetNode(id)
	if err != nil {
		writeErr(w, notFound("规则节点不存在"))
		return
	}
	if err := a.repo.DeleteNode(id); err != nil {
		writeErr(w, err)
		return
	}
	a.repo.Audit("admin", "node.delete", n.Name, "")
	writeOK(w, map[string]any{"deleted": id})
}

// ---------- 告警 ----------

func (a *API) handleListAlarms(w http.ResponseWriter, r *http.Request) {
	f := repoAlarmFilter(r)
	rows, total, err := a.repo.ListAlarms(f)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, map[string]any{
		"items": rows, "total": total, "page": f.Page, "pageSize": f.PageSize,
	})
}

func (a *API) handleGetAlarm(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	al, err := a.repo.GetAlarm(id)
	if err != nil {
		if err == sql.ErrNoRows {
			writeErr(w, notFound("告警不存在"))
			return
		}
		writeErr(w, err)
		return
	}
	writeOK(w, al)
}

func (a *API) handleAlarmStats(w http.ResponseWriter, r *http.Request) {
	today := time.Now().Truncate(24 * time.Hour).Unix()
	st, err := a.alarm.Stats(today)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, st)
}

// actionBody 解析处置请求体（操作人 + 备注），缺省为 operator / 空。
// EXT-POINT(INTEGRATION): 接入统一鉴权后 actor 应取自登录态，而非请求体。
func actionBody(r *http.Request) (actor, note string) {
	actor, note = "operator", ""
	var body struct {
		By     string `json:"by"`
		Reason string `json:"reason"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}
	if body.By != "" {
		actor = body.By
	}
	return actor, body.Reason
}

func (a *API) handleAck(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	actor, _ := actionBody(r)
	al, err := a.alarm.Ack(id, actor)
	if err != nil {
		writeErr(w, conflict(err.Error()))
		return
	}
	writeOK(w, al)
}

func (a *API) handleClear(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	actor, note := actionBody(r)
	al, err := a.alarm.Clear(id, actor, note)
	if err != nil {
		writeErr(w, conflict(err.Error()))
		return
	}
	writeOK(w, al)
}

func (a *API) handleFalseReport(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	actor, note := actionBody(r)
	al, err := a.alarm.FalseReport(id, actor, note)
	if err != nil {
		writeErr(w, conflict(err.Error()))
		return
	}
	writeOK(w, al)
}
