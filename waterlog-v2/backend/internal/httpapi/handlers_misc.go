package httpapi

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"waterlog/v2/internal/repo"
	"waterlog/v2/webembed"
)

func repoAlarmFilter(r *http.Request) repo.AlarmFilter {
	q := r.URL.Query()
	f := repo.AlarmFilter{
		Status:   q.Get("status"),
		LevelKey: q.Get("level"),
		DeviceID: queryInt64(r, "deviceId", 0),
		Page:     queryInt(r, "page", 1),
		PageSize: queryInt(r, "pageSize", 20),
	}
	if q.Get("active") == "1" || f.Status == "active" {
		f.ActiveOnly = f.Status == "active" || f.Status == ""
		f.Status = ""
	}
	return f
}

// ---------- 大屏 ----------

func (a *API) handleGetDashboard(w http.ResponseWriter, r *http.Request) {
	d, err := a.repo.GetDefaultDashboard()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, d)
}

func (a *API) handleUpdateDashboard(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	var in struct {
		Name    string `json:"name"`
		Layout  []any  `json:"layout"`
		Widgets []any  `json:"widgets"`
	}
	if err := decodeBody(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	cur, err := a.repo.GetDefaultDashboard()
	if err != nil || cur.ID != id {
		writeErr(w, notFound("大屏不存在"))
		return
	}
	if in.Name != "" {
		cur.Name = in.Name
	}
	// 原样保存 JSON
	if in.Layout != nil {
		b, _ := json.Marshal(in.Layout)
		cur.Layout = string(b)
	}
	if in.Widgets != nil {
		b, _ := json.Marshal(in.Widgets)
		cur.Widgets = string(b)
	}
	if err := a.repo.UpdateDashboard(cur); err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, cur)
}

// ---------- 静态资源 ----------

// serveSPA 提供 embed 的前端；非静态路径回退 index.html（前端路由）。
func (a *API) serveSPA(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		http.NotFound(w, r)
		return
	}
	sub, err := fs.Sub(webembed.FS, "web")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if p == "" || p == "." {
		p = "index.html"
	}
	if _, err := fs.Stat(sub, p); err != nil {
		// SPA fallback
		data, err := fs.ReadFile(sub, "index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(data)
		return
	}
	http.FileServer(http.FS(sub)).ServeHTTP(w, r)
}

// handleAlertLevels 预警等级视图（阈值由规则表推导）。
func (a *API) handleAlertLevels(w http.ResponseWriter, r *http.Request) {
	rows, err := a.repo.WaterLevelLevels()
	if err != nil {
		writeErr(w, err)
		return
	}
	// 配色与前端视觉契约一致（蓝/黄/橙/红）
	colorOf := map[string]string{"blue": "#2563EB", "yellow": "#D97706", "orange": "#EA580C", "red": "#DC2626"}
	nameOf := map[string]string{"blue": "蓝色预警", "yellow": "黄色预警", "orange": "橙色预警", "red": "红色预警"}
	out := make([]map[string]any, 0, len(rows))
	for _, lv := range rows {
		out = append(out, map[string]any{
			"rank": lv.Rank, "levelKey": lv.LevelKey, "name": nameOf[lv.LevelKey],
			"color": colorOf[lv.LevelKey], "waterLevelThreshold": lv.Threshold,
		})
	}
	writeOK(w, out)
}
