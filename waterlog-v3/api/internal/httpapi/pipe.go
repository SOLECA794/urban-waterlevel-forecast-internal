package httpapi

import (
	"io"
	"net/http"

	"waterlog-v3/api/internal/service"
)

// pipe 把引擎响应原样写回给前端（状态码 + body）。
func pipe(w http.ResponseWriter, res *service.ProxyResult) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(res.Status)
	_, _ = io.Copy(w, res.Body)
}
