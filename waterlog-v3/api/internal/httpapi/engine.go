package httpapi

import (
	"io"
	"net/http"
)

// ---------------------------------------------------------------- 引擎反代
//
// 规则、模型版本、重训、降雨注入这些请求全部原样转发给 Python 引擎，
// 状态码与响应体也原样回传——前端就是照着引擎的响应写的。
// Go 侧不做二次解释，唯一例外是转发成功后要广播 SSE（模型换了，曲线全变）。

// proxyGet 把 GET（含 query）转发给引擎。
func (s *Server) proxyGet(path string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		res, err := s.eng.Get(path, r.URL.RawQuery)
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "引擎不可达: "+err.Error())
			return
		}
		defer res.Close()
		pipe(w, res)
	}
}

// proxyPost 把 POST（body 可选，query 透传）转发给引擎。
func (s *Server) proxyPost(path string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			fail(w, http.StatusBadRequest, err.Error())
			return
		}
		res, err := s.eng.PostJSON(path, r.URL.RawQuery, raw)
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "引擎不可达: "+err.Error())
			return
		}
		defer res.Close()
		pipe(w, res)
	}
}

// command 转发一个无 body 的「命令型」POST（重训、注雨、排空积水）。
func (s *Server) command(path string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		res, err := s.eng.PostEmpty(path, r.URL.RawQuery)
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "引擎不可达: "+err.Error())
			return
		}
		defer res.Close()
		pipe(w, res)
	}
}

func (s *Server) putRules(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	res, err := s.eng.PutJSON("/rules", raw)
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "引擎不可达: "+err.Error())
		return
	}
	defer res.Close()
	pipe(w, res)
	// 规则变了等级可能立刻变，让所有前端重拉
	s.svc.Hub().Broadcast("rules", map[string]any{"ok": res.Status < 400})
}

// adoptModel 采纳/回滚模型版本。成功后要让所有前端重拉：
// 模型换了，预测曲线、预警等级、评估口径全都变了。
func (s *Server) adoptModel(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	res, err := s.eng.PostJSON("/models/adopt", r.URL.RawQuery, raw)
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "引擎不可达: "+err.Error())
		return
	}
	defer res.Close()
	pipe(w, res)
	if res.Status < 400 {
		s.svc.Hub().Broadcast("forecast", map[string]any{"action": "model_adopted"})
	}
}
