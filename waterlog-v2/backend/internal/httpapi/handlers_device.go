package httpapi

import (
	"database/sql"
	"net/http"
	"strings"
	"time"

	"waterlog/v2/internal/model"
)

// ---------- 设备画像 ----------

func (a *API) handleListProfiles(w http.ResponseWriter, r *http.Request) {
	list, err := a.repo.ListProfiles()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, list)
}

func (a *API) handleCreateProfile(w http.ResponseWriter, r *http.Request) {
	var p model.DeviceProfile
	if err := decodeBody(r, &p); err != nil {
		writeErr(w, err)
		return
	}
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		writeErr(w, badRequest("画像名称不能为空"))
		return
	}
	if p.Category == "" {
		p.Category = "water_level"
	}
	if len(p.Keys) == 0 {
		p.Keys = []string{"water_level"}
	}
	if err := a.repo.CreateProfile(&p); err != nil {
		writeErr(w, conflict("创建失败（名称可能重复）："+err.Error()))
		return
	}
	writeOK(w, p)
}

func (a *API) handleUpdateProfile(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	cur, err := a.repo.GetProfile(id)
	if err != nil {
		writeErr(w, notFound("画像不存在"))
		return
	}
	var p model.DeviceProfile
	if err := decodeBody(r, &p); err != nil {
		writeErr(w, err)
		return
	}
	cur.Name, cur.Category, cur.Description = p.Name, p.Category, p.Description
	if len(p.Keys) > 0 {
		cur.Keys = p.Keys
	}
	if err := a.repo.UpdateProfile(cur); err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, cur)
}

func (a *API) handleDeleteProfile(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := a.repo.DeleteProfile(id); err != nil {
		writeErr(w, conflict(err.Error()))
		return
	}
	writeOK(w, map[string]any{"deleted": id})
}

// ---------- 设备 ----------

func (a *API) handleListDevices(w http.ResponseWriter, r *http.Request) {
	list, err := a.repo.ListDevices()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, list)
}

func (a *API) handleGetDevice(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	d, err := a.repo.GetDevice(id)
	if err != nil {
		writeErr(w, notFound("设备不存在"))
		return
	}
	writeOK(w, d)
}

func (a *API) handleCreateDevice(w http.ResponseWriter, r *http.Request) {
	var d model.Device
	if err := decodeBody(r, &d); err != nil {
		writeErr(w, err)
		return
	}
	d.Name = strings.TrimSpace(d.Name)
	d.Code = strings.TrimSpace(d.Code)
	if d.Name == "" || d.Code == "" {
		writeErr(w, badRequest("设备名称与编码不能为空"))
		return
	}
	if d.ProfileID <= 0 {
		writeErr(w, badRequest("必须指定设备画像 profileId"))
		return
	}
	if _, err := a.repo.GetProfile(d.ProfileID); err != nil {
		writeErr(w, badRequest("设备画像不存在"))
		return
	}
	d.Status = model.DeviceOffline
	if err := a.repo.CreateDevice(&d); err != nil {
		writeErr(w, conflict("创建设备失败（编码可能重复）："+err.Error()))
		return
	}
	a.tel.InvalidateDeviceCache()
	a.repo.Audit("admin", "device.create", d.Code, d.Name)
	writeOK(w, d)
}

func (a *API) handleUpdateDevice(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	cur, err := a.repo.GetDevice(id)
	if err != nil {
		writeErr(w, notFound("设备不存在"))
		return
	}
	var d model.Device
	if err := decodeBody(r, &d); err != nil {
		writeErr(w, err)
		return
	}
	if d.Name != "" {
		cur.Name = d.Name
	}
	if d.Code != "" {
		cur.Code = d.Code
	}
	if d.ProfileID > 0 {
		cur.ProfileID = d.ProfileID
	}
	cur.Lat, cur.Lon, cur.Address = d.Lat, d.Lon, d.Address
	cur.Enabled = d.Enabled
	if err := a.repo.UpdateDevice(cur); err != nil {
		writeErr(w, conflict("更新失败："+err.Error()))
		return
	}
	a.tel.InvalidateDeviceCache()
	a.repo.Audit("admin", "device.update", cur.Code, cur.Name)
	writeOK(w, cur)
}

func (a *API) handleDeleteDevice(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	d, err := a.repo.GetDevice(id)
	if err != nil {
		writeErr(w, notFound("设备不存在"))
		return
	}
	if err := a.repo.DeleteDevice(id); err != nil {
		writeErr(w, err)
		return
	}
	a.tel.InvalidateDeviceCache()
	a.rule.ResetDevice(id)
	a.repo.Audit("admin", "device.delete", d.Code, d.Name)
	writeOK(w, map[string]any{"deleted": id})
}

// ---------- 遥测 ----------

func (a *API) handleTelemetry(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	metric := r.URL.Query().Get("metric")
	if metric == "" {
		metric = "water_level"
	}
	to := queryInt64(r, "to", time.Now().Unix())
	from := queryInt64(r, "from", to-3*3600)
	limit := queryInt(r, "limit", 300)
	rows, err := a.repo.Series(id, metric, from, to, limit)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, map[string]any{
		"deviceId": id, "metric": metric, "from": from, "to": to,
		"points": rows,
	})
}

func (a *API) handleLatest(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	vals, err := a.repo.LatestMetrics(id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, vals)
}

func (a *API) handleIngest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Samples []model.Sample `json:"samples"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	if len(body.Samples) == 0 {
		writeErr(w, badRequest("samples 不能为空"))
		return
	}
	res := a.tel.Ingest(body.Samples, "api")
	writeOK(w, res)
}

// ---------- 预测 ----------

func (a *API) handleForecast(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, err := a.repo.GetDevice(id); err != nil {
		writeErr(w, notFound("设备不存在"))
		return
	}
	metric := r.URL.Query().Get("metric")
	horizon := queryInt(r, "horizon", 60)
	step := queryInt(r, "step", 5)
	res, err := a.fc.Run(id, metric, horizon, step)
	if err != nil {
		if err == sql.ErrNoRows {
			writeOK(w, map[string]any{"points": []any{}, "note": "暂无历史数据"})
			return
		}
		writeErr(w, err)
		return
	}
	writeOK(w, res)
}

func (a *API) handleLatestAll(w http.ResponseWriter, r *http.Request) {
	rows, err := a.repo.LatestAll()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, rows)
}
