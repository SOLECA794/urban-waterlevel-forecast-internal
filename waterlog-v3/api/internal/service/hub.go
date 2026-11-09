package service

import (
	"encoding/json"
	"fmt"
	"sync"
)

// Hub 是极简的 SSE 广播中心。
//
// 为什么用 SSE 而不是 WebSocket：这里只有服务端→客户端的单向推送（遥测、预警变更），
// 不需要双向；SSE 走原生 EventSource，自带断线重连，比 WS 少一整层心跳与重连逻辑。
// 慢客户端不阻塞：每个订阅者一个带缓冲的 channel，满了就丢帧——丢一帧曲线无所谓，
// 拖垮整个广播才要命。
type Hub struct {
	mu      sync.RWMutex
	clients map[chan []byte]struct{}
}

// NewHub 创建广播中心。
func NewHub() *Hub {
	return &Hub{clients: make(map[chan []byte]struct{})}
}

// Subscribe 注册一个订阅者，返回带缓冲的帧通道。
func (h *Hub) Subscribe() chan []byte {
	ch := make(chan []byte, 32)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

// Unsubscribe 注销订阅者并关闭其通道。
func (h *Hub) Unsubscribe(ch chan []byte) {
	h.mu.Lock()
	if _, ok := h.clients[ch]; ok {
		delete(h.clients, ch)
		close(ch)
	}
	h.mu.Unlock()
}

// Broadcast 把一次事件编码成 SSE 帧发给所有订阅者。
// 事件名（hello/telemetry/forecast/warning/rules）是前端写死的契约，不能改。
func (h *Hub) Broadcast(event string, payload any) {
	b, err := json.Marshal(payload)
	if err != nil {
		return
	}
	frame := []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", event, b))
	h.mu.RLock()
	defer h.mu.RUnlock()
	for ch := range h.clients {
		select {
		case ch <- frame:
		default: // 满了就丢，绝不阻塞广播
		}
	}
}

// Count 返回当前订阅者数量。
func (h *Hub) Count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}
