// 事件总线：预警产生/状态变更 → SSE /stream/alerts 实时推送。
package service

import (
	"encoding/json"
	"sync"
)

// Bus 进程内发布订阅总线（SSE 单实例场景足够）。
type Bus struct {
	mu   sync.Mutex
	subs map[chan []byte]struct{}
}

// NewBus 构造。
func NewBus() *Bus {
	return &Bus{subs: map[chan []byte]struct{}{}}
}

// Subscribe 订阅（返回带缓冲的事件通道）。
func (b *Bus) Subscribe() chan []byte {
	ch := make(chan []byte, 32)
	b.mu.Lock()
	b.subs[ch] = struct{}{}
	b.mu.Unlock()
	return ch
}

// Unsubscribe 退订并关闭通道。
func (b *Bus) Unsubscribe(ch chan []byte) {
	b.mu.Lock()
	if _, ok := b.subs[ch]; ok {
		delete(b.subs, ch)
		close(ch)
	}
	b.mu.Unlock()
}

// Publish 广播事件（eventType + payload 组装为 SSE data JSON）。非阻塞。
func (b *Bus) Publish(eventType string, payload any) {
	blob, err := json.Marshal(map[string]any{"event": eventType, "data": payload})
	if err != nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs {
		select {
		case ch <- blob:
		default: // 订阅方阻塞则丢弃，SSE 场景可接受
		}
	}
}
