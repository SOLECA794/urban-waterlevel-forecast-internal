package httpapi

import (
	"encoding/json"
	"net/http"

	"waterlog-v3/api/internal/domain"
)

// ---------------------------------------------------------------- 写入端
//
// 这两个端点的调用方只有 Python 引擎，不接受浏览器直接写。
// 之所以还要走 HTTP 而不是共享数据库：引擎是唯一的数据生产者，
// 让它的写入路径与读路径一样经过 Go，预警四态的迁移才能只在一个地方判定。

func (s *Server) ingestTelemetry(w http.ResponseWriter, r *http.Request) {
	var batch domain.TelemetryBatch
	if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
		fail(w, http.StatusBadRequest, "bad json: "+err.Error())
		return
	}
	n, err := s.svc.IngestTelemetry(batch)
	if err != nil {
		failErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "n": n})
}

func (s *Server) ingestForecast(w http.ResponseWriter, r *http.Request) {
	var p domain.ForecastPayload
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		fail(w, http.StatusBadRequest, "bad json: "+err.Error())
		return
	}
	n, actions, warn := s.svc.IngestForecast(p)
	if warn != nil {
		// 决策日志写失败不阻断主流程，但要如实告诉调用方
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "warn": warn.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sites": n, "actions": actions})
}
