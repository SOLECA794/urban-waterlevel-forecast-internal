package httpapi

import (
	"fmt"
	"net/http"
)

// events 是 SSE 端点。
//
// 为什么用 SSE 而不是 WebSocket：这里只有服务端→客户端的单向推送（遥测、预警变更），
// 不需要双向；SSE 走原生 EventSource，自带断线重连，比 WS 少一整层心跳与重连逻辑。
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // 让 nginx 别缓冲

	hub := s.svc.Hub()
	ch := hub.Subscribe()
	defer hub.Unsubscribe(ch)

	// 首帧发一个 hello，让前端立刻知道连上了，不用等第一次广播
	fmt.Fprint(w, "event: hello\ndata: {\"ok\":true}\n\n")
	fl.Flush()

	for {
		select {
		case <-r.Context().Done():
			return
		case frame, ok := <-ch:
			if !ok {
				return
			}
			if _, err := w.Write(frame); err != nil {
				return
			}
			fl.Flush()
		}
	}
}
