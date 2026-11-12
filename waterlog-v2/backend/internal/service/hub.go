// Package service 业务层：遥测管道、规则引擎、告警状态机、模拟数据源、预测占位。
package service

import (
	"encoding/json"
	"sync"
	"time"
)

// Event 推送给前端的事件（SSE data 行）。
type Event struct {
	Type    string `json:"type"` // telemetry | alarm | device
	Payload any    `json:"payload"`
	Ts      int64  `json:"ts"`
}

// Hub 极简发布订阅：SSE 单向下行。
// EXT-POINT(INTEGRATION): 若需 WebSocket 双向通道（远程指令下发），在此替换传输层，
// 事件模型（Event）与订阅契约保持不变，前端改用 ws 客户端即可。
type Hub struct {
	mu   sync.RWMutex
	subs map[int64]chan []byte
	seq  int64
}

func NewHub() *Hub {
	return &Hub{subs: make(map[int64]chan []byte)}
}

// Subscribe 注册订阅者，返回事件通道与取消函数。
func (h *Hub) Subscribe() (<-chan []byte, func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.seq++
	id := h.seq
	ch := make(chan []byte, 64)
	h.subs[id] = ch
	return ch, func() {
		h.mu.Lock()
		if c, ok := h.subs[id]; ok {
			delete(h.subs, id)
			close(c)
		}
		h.mu.Unlock()
	}
}

// Publish 广播事件；慢订阅者丢弃（背压保护，不阻塞写入主链路）。
func (h *Hub) Publish(t string, payload any) {
	b, err := json.Marshal(Event{Type: t, Payload: payload, Ts: time.Now().Unix()})
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, ch := range h.subs {
		select {
		case ch <- b:
		default: // 丢弃
		}
	}
}

// Subscribers 当前订阅数（运维探针）。
func (h *Hub) Subscribers() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subs)
}
