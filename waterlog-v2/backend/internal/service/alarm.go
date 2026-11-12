package service

import (
	"database/sql"
	"fmt"
	"log"
	"time"

	"waterlog/v2/internal/model"
	"waterlog/v2/internal/repo"
)

// AlarmService 告警生命周期状态机（对标 ThingsBoard Alarm：四态 + 确认/清除正交）。
type AlarmService struct {
	repo        *repo.Repo
	hub         *Hub
	cooldownSec int64
}

func NewAlarmService(r *repo.Repo, h *Hub, cooldownSec int) *AlarmService {
	if cooldownSec <= 0 {
		cooldownSec = 180
	}
	return &AlarmService{repo: r, hub: h, cooldownSec: int64(cooldownSec)}
}

// Raise 触发告警：已有生效告警则只刷新当前值（幂等）。
func (s *AlarmService) Raise(dev *model.Device, n *model.RuleNode, value float64, ts int64) {
	if existing, err := s.repo.ActiveAlarm(dev.ID, n.ID); err == nil && existing != nil {
		s.RefreshActive(dev.ID, n.ID, value, ts)
		return
	} else if err != nil && err != sql.ErrNoRows {
		log.Printf("[alarm] 查询在途告警失败: %v", err)
		return
	}
	// 重复触发冷却：同一设备同一规则解除后 N 秒内不重复触发（避免抖动刷屏）。
	// N 由 ALARM_COOLDOWN_SEC 配置，默认 180s。
	if last, err := s.repo.LastCleared(dev.ID, n.ID); err == nil && last != nil &&
		last.ClearTs != nil && ts-*last.ClearTs < s.cooldownSec {
		return
	}
	nodeID := n.ID
	a := &model.Alarm{
		DeviceID:     dev.ID,
		RuleNodeID:   &nodeID,
		LevelKey:     n.LevelKey,
		LevelRank:    n.LevelRank,
		Severity:     n.Severity,
		Status:       model.AlarmActiveUnack,
		StartTs:      ts,
		TriggerValue: &value,
		CurrentValue: &value,
		Message:      fmt.Sprintf("%s 触发%s：%s %s %.2f（阈值 %.2f）", dev.Name, levelName(n.LevelKey), n.Metric, opName(n.Op), value, n.Threshold),
	}
	if err := s.repo.CreateAlarm(a); err != nil {
		log.Printf("[alarm] 创建告警失败: %v", err)
		return
	}
	s.repo.Audit("system", "alarm.raise", fmt.Sprintf("alarm/%d", a.ID), a.Message)
	s.publish("alarm.raise", a)
}

// RefreshActive 刷新在途告警的当前值。
func (s *AlarmService) RefreshActive(deviceID, nodeID int64, value float64, ts int64) {
	a, err := s.repo.ActiveAlarm(deviceID, nodeID)
	if err != nil || a == nil {
		return
	}
	a.CurrentValue = &value
	_ = s.repo.UpdateAlarmState(a)
}

// AutoClear 条件恢复时的自动解除（ACTIVE_UNACK→CLEARED_UNACK；ACTIVE_ACK→CLEARED_ACK）。
func (s *AlarmService) AutoClear(deviceID, nodeID int64, value float64, ts int64) {
	a, err := s.repo.ActiveAlarm(deviceID, nodeID)
	if err != nil || a == nil {
		return
	}
	target, err := a.Transition("clear")
	if err != nil {
		return
	}
	reason := model.ClearAuto
	by := "system"
	a.Status = target
	a.ClearTs = &ts
	a.ClearedBy = &by
	a.ClearReason = &reason
	a.CurrentValue = &value
	if err := s.repo.UpdateAlarmState(a); err != nil {
		log.Printf("[alarm] 自动解除失败: %v", err)
		return
	}
	s.repo.Audit(by, "alarm.auto_clear", fmt.Sprintf("alarm/%d", a.ID), a.Message)
	s.publish("alarm.clear", a)
}

// Ack 人工确认。
func (s *AlarmService) Ack(id int64, actor string) (*model.Alarm, error) {
	return s.transition(id, "ack", actor, "")
}

// Clear 人工解除。reason 为空时记为 manual。
func (s *AlarmService) Clear(id int64, actor, reason string) (*model.Alarm, error) {
	return s.transition(id, "clear", actor, reason)
}

// FalseReport 标记误报（等价解除，clear_reason=false_report）。
func (s *AlarmService) FalseReport(id int64, actor, reason string) (*model.Alarm, error) {
	return s.transition(id, "false_report", actor, reason)
}

func (s *AlarmService) transition(id int64, action, actor, note string) (*model.Alarm, error) {
	a, err := s.repo.GetAlarm(id)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("告警 %d 不存在", id)
		}
		return nil, err
	}
	target, err := a.Transition(action) // 状态机校验
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	a.Status = target
	switch action {
	case "ack":
		a.AckTs = &now
		a.AckBy = &actor
	case "clear", "false_report":
		reason := model.ClearManual
		if action == "false_report" {
			reason = model.ClearFalseReport
		}
		if note != "" {
			reason = note
		}
		a.ClearTs = &now
		a.ClearedBy = &actor
		a.ClearReason = &reason
	}
	if err := s.repo.UpdateAlarmState(a); err != nil {
		return nil, err
	}
	s.repo.Audit(actor, "alarm."+action, fmt.Sprintf("alarm/%d", id),
		fmt.Sprintf("%s → %s %s", action, target, note))
	s.publish("alarm."+action, a)
	return a, nil
}

func (s *AlarmService) Stats(todayStart int64) (*model.AlarmStats, error) {
	return s.repo.AlarmStats(todayStart)
}

func (s *AlarmService) publish(t string, a *model.Alarm) {
	s.hub.Publish(t, a)
}

func levelName(k string) string {
	switch k {
	case "blue":
		return "蓝色预警"
	case "yellow":
		return "黄色预警"
	case "orange":
		return "橙色预警"
	case "red":
		return "红色预警"
	}
	return k
}

func opName(op string) string {
	switch op {
	case "gt":
		return ">"
	case "gte":
		return ">="
	case "lt":
		return "<"
	case "lte":
		return "<="
	}
	return op
}
