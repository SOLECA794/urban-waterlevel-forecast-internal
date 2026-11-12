package service

import (
	"log"
	"sync"
	"time"

	"waterlog/v2/internal/model"
	"waterlog/v2/internal/repo"
)

// RuleEngine 规则求值：metric 条件 + 持续时长 → 告警生命周期。
// 设计对标 ThingsBoard Rule Chain 的简化子集：条件节点 + 时长窗口 + 告警动作。
// EXT-POINT(ALGORITHM): 可视化规则编排（节点图/连线/脚本节点）在此扩展，
// 当前仅支持「单条件 + 持续时长」线性规则，配置入口为 rule_node 表与 REST 表单。
type RuleEngine struct {
	repo  *repo.Repo
	alarm *AlarmService

	mu     sync.Mutex
	states map[stateKey]*condState // (deviceID,nodeID) → 首次满足时刻
}

type stateKey struct {
	DeviceID int64
	NodeID   int64
}

type condState struct {
	FirstTrueTs int64
}

func NewRuleEngine(r *repo.Repo, a *AlarmService) *RuleEngine {
	return &RuleEngine{repo: r, alarm: a, states: make(map[stateKey]*condState)}
}

// Evaluate 对一次遥测样本执行全部启用规则。
func (e *RuleEngine) Evaluate(dev *model.Device, metric string, value float64, ts int64) {
	nodes, err := e.repo.ListEnabledNodes()
	if err != nil {
		log.Printf("[rule] 读取规则失败: %v", err)
		return
	}
	for i := range nodes {
		n := &nodes[i]
		if n.Metric != metric {
			continue
		}
		// 画像定向：为空表示全画像生效
		if n.DeviceProfileID != nil && *n.DeviceProfileID != dev.ProfileID {
			continue
		}
		e.apply(dev, n, value, ts)
		// 同一 metric 命中高等级规则后继续求值，保证多级告警独立（与 ThingsBoard 多 alarm 并存一致）
	}
}

func (e *RuleEngine) apply(dev *model.Device, n *model.RuleNode, value float64, ts int64) {
	key := stateKey{dev.ID, n.ID}
	hit := n.Match(value)

	e.mu.Lock()
	if hit {
		st, ok := e.states[key]
		if !ok {
			e.states[key] = &condState{FirstTrueTs: ts}
			e.mu.Unlock()
			return // 首次满足，进入观察窗口
		}
		dur := ts - st.FirstTrueTs
		e.mu.Unlock()

		if dur < n.DurationSec {
			// 未达持续时长：仅刷新在途告警的当前值
			e.alarm.RefreshActive(dev.ID, n.ID, value, ts)
			return
		}
		// 达到持续时长 → 触发（幂等：已有生效告警则只刷新）
		e.alarm.Raise(dev, n, value, ts)
		return
	}

	// 条件不再满足：清状态 + 自动解除
	delete(e.states, key)
	e.mu.Unlock()
	e.alarm.AutoClear(dev.ID, n.ID, value, ts)
}

// ResetDevice 设备/规则变更后清理窗口状态（避免陈旧窗口误触发）。
func (e *RuleEngine) ResetDevice(deviceID int64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for k := range e.states {
		if k.DeviceID == deviceID {
			delete(e.states, k)
		}
	}
}

// PurgeStale 清理长时间未更新的窗口（设备离线后窗口不应永久保留）。
func (e *RuleEngine) PurgeStale(before int64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for k, st := range e.states {
		if st.FirstTrueTs < before {
			delete(e.states, k)
		}
	}
}

// StartJanitor 周期清理陈旧窗口。
func (e *RuleEngine) StartJanitor(stop <-chan struct{}) {
	t := time.NewTicker(10 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			e.PurgeStale(time.Now().Add(-6 * time.Hour).Unix())
		case <-stop:
			return
		}
	}
}
