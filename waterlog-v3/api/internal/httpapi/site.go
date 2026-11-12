package httpapi

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
)

// ---------------------------------------------------------------- 读端

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{
		"ok":      true,
		"service": "waterlog-v3-api",
		"ts":      s.svc.NowTS(),
		"clients": s.svc.Hub().Count(),
		"engine":  s.eng.URL(),
	}
	// 顺带探一下引擎，前端据此显示「引擎在线/离线」。
	// 引擎挂了 API 还活着是正常状态（读缓存、看历史、翻预警都还能用），
	// 所以这里只标记 engine_ok，不返回非 200。
	if eng, ok := s.eng.Health(); ok {
		out["engine_ok"] = true
		out["engine_health"] = eng
	} else {
		out["engine_ok"] = false
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) listSites(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"sites": s.svc.Sites()})
}

// overview 是「一张图」的数据源：站点按预警等级着色，需要一次性拿到全部状态。
func (s *Server) overview(w http.ResponseWriter, r *http.Request) {
	rows, now, err := s.svc.Overview()
	if err != nil {
		failErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sites": rows, "issued_at": now})
}

func (s *Server) siteDetail(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	detail, ok, err := s.svc.SiteDetail(id)
	if err != nil {
		failErr(w, err)
		return
	}
	if !ok {
		fail(w, http.StatusNotFound, "unknown site")
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) siteHistory(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	hours, _ := strconv.Atoi(r.URL.Query().Get("hours"))
	if hours <= 0 || hours > 48 {
		hours = 24
	}
	pts, err := s.svc.SiteHistory(id, hours)
	if err != nil {
		failErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"site_id": id, "hours": hours, "points": pts})
}

// allHistory 一次返回所有站在最近 N 小时的历史序列，按 site_id 分组。
// 大屏的热力图与全域趋势都要十站历史，逐站十次请求在轮播屏上代价太高。
func (s *Server) allHistory(w http.ResponseWriter, r *http.Request) {
	hours, _ := strconv.Atoi(r.URL.Query().Get("hours"))
	if hours <= 0 || hours > 48 {
		hours = 24
	}
	m, err := s.svc.SeriesAll(hours)
	if err != nil {
		failErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"hours": hours, "sites": m})
}

func (s *Server) getForecast(w http.ResponseWriter, r *http.Request) {
	fc := s.svc.Forecast()
	if fc == nil {
		fail(w, http.StatusServiceUnavailable, "尚无预测快照，请确认引擎已启动")
		return
	}
	writeJSON(w, http.StatusOK, fc)
}
