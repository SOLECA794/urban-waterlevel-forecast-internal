// Package model 领域模型：对标 ThingsBoard 的设备画像 / 设备 / 遥测 / 规则链 / 告警生命周期。
// 本文件只定义数据结构与合法性校验，不含数据库访问（见 repo）与业务流程（见 service）。
package model

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
)

// Bool SQLite INTEGER(0/1) ↔ Go bool，JSON 输出 true/false。
// 原因：modernc sqlite 的 INTEGER 返回 int64，database/sql 不能直接扫描进 bool。
type Bool bool

// Scan 实现 sql.Scanner。
func (b *Bool) Scan(src any) error {
	switch v := src.(type) {
	case nil:
		*b = false
	case bool:
		*b = Bool(v)
	case int64:
		*b = v != 0
	case []byte:
		*b = len(v) > 0 && (v[0] == '1' || v[0] == 't' || v[0] == 'T')
	case string:
		*b = v == "1" || v == "true"
	default:
		return fmt.Errorf("Bool.Scan 不支持的来源类型 %T", src)
	}
	return nil
}

// Value 实现 driver.Valuer。
func (b Bool) Value() (driver.Value, error) { return bool(b), nil }

// MarshalJSON 输出布尔值。
func (b Bool) MarshalJSON() ([]byte, error) { return json.Marshal(bool(b)) }

// UnmarshalJSON 接受布尔值。
func (b *Bool) UnmarshalJSON(data []byte) error {
	var v bool
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
	*b = Bool(v)
	return nil
}

// ---------- 设备画像 DeviceProfile ----------

type DeviceProfile struct {
	ID            int64  `db:"id" json:"id"`
	Name          string `db:"name" json:"name"`
	Category      string `db:"category" json:"category"`
	TelemetryKeys string `db:"telemetry_keys" json:"-"` // JSON 数组字符串
	Description   string `db:"description" json:"description"`
	CreatedAt     int64  `db:"created_at" json:"createdAt"`
	UpdatedAt     int64  `db:"updated_at" json:"updatedAt"`

	Keys []string `json:"telemetryKeys" db:"-"`
}

// ---------- 设备 Device ----------

type Device struct {
	ID         int64   `db:"id" json:"id"`
	ProfileID  int64   `db:"profile_id" json:"profileId"`
	Name       string  `db:"name" json:"name"`
	Code       string  `db:"code" json:"code"`
	Lat        float64 `db:"lat" json:"lat"`
	Lon        float64 `db:"lon" json:"lon"`
	Address    string  `db:"address" json:"address"`
	Status     string  `db:"status" json:"status"` // online / stale / offline
	Enabled    Bool    `db:"enabled" json:"enabled"`
	LastSeenAt *int64  `db:"last_seen_at" json:"lastSeenAt"`
	CreatedAt  int64   `db:"created_at" json:"createdAt"`
	UpdatedAt  int64   `db:"updated_at" json:"updatedAt"`

	// 联表附加字段
	ProfileName string `db:"profile_name" json:"profileName"`
}

// DeviceStatus 设备状态常量。
const (
	DeviceOnline  = "online"
	DeviceStale   = "stale"
	DeviceOffline = "offline"
)

// ---------- 遥测 Telemetry ----------

type Telemetry struct {
	ID       int64   `db:"id" json:"id"`
	DeviceID int64   `db:"device_id" json:"deviceId"`
	Metric   string  `db:"metric" json:"metric"`
	Ts       int64   `db:"ts" json:"ts"`
	Value    float64 `db:"value" json:"value"`
	Quality  string  `db:"quality" json:"quality"`
}

// Sample 一次遥测上报（一台设备一个时刻的多个键值）。
type Sample struct {
	DeviceCode string             `json:"deviceCode"`
	Ts         int64              `json:"ts"`
	Values     map[string]float64 `json:"values"`
	Quality    string             `json:"quality"`
}

// ---------- 规则链 RuleChain / RuleNode ----------

type RuleChain struct {
	ID          int64  `db:"id" json:"id"`
	Name        string `db:"name" json:"name"`
	Description string `db:"description" json:"description"`
	Enabled     Bool   `db:"enabled" json:"enabled"`
	CreatedAt   int64  `db:"created_at" json:"createdAt"`
	UpdatedAt   int64  `db:"updated_at" json:"updatedAt"`

	Nodes []RuleNode `json:"nodes" db:"-"`
}

// RuleNode 简化规则节点：metric + op + threshold + duration → level/severity/actions。
type RuleNode struct {
	ID              int64   `db:"id" json:"id"`
	ChainID         int64   `db:"chain_id" json:"chainId"`
	Name            string  `db:"name" json:"name"`
	DeviceProfileID *int64  `db:"device_profile_id" json:"deviceProfileId"`
	Metric          string  `db:"metric" json:"metric"`
	Op              string  `db:"op" json:"op"`
	Threshold       float64 `db:"threshold" json:"threshold"`
	DurationSec     int64   `db:"duration_sec" json:"durationSec"`
	LevelKey        string  `db:"level_key" json:"levelKey"`
	LevelRank       int64   `db:"level_rank" json:"levelRank"`
	Severity        string  `db:"severity" json:"severity"`
	Actions         string  `db:"actions" json:"-"`
	Priority        int64   `db:"priority" json:"priority"`
	Enabled         Bool    `db:"enabled" json:"enabled"`
	CreatedAt       int64   `db:"created_at" json:"createdAt"`
	UpdatedAt       int64   `db:"updated_at" json:"updatedAt"`

	ActionsList []string `json:"actions" db:"-"`
}

// Match 判断被测值是否满足条件。
func (n *RuleNode) Match(v float64) bool {
	switch n.Op {
	case "gt":
		return v > n.Threshold
	case "gte":
		return v >= n.Threshold
	case "lt":
		return v < n.Threshold
	case "lte":
		return v <= n.Threshold
	}
	return false
}

// Validate 校验操作符与等级。
func (n *RuleNode) Validate() error {
	switch n.Op {
	case "gt", "gte", "lt", "lte":
	default:
		return fmt.Errorf("非法操作符 %q（允许 gt/gte/lt/lte）", n.Op)
	}
	switch n.LevelKey {
	case "blue", "yellow", "orange", "red":
	default:
		return fmt.Errorf("非法等级 %q（允许 blue/yellow/orange/red）", n.LevelKey)
	}
	if n.Metric == "" {
		return fmt.Errorf("metric 不能为空")
	}
	if n.DurationSec < 0 {
		return fmt.Errorf("durationSec 不能为负")
	}
	return nil
}

// ---------- 告警 Alarm：四态生命周期 ----------

// 告警状态：在线/已恢复 × 未确认/已确认 两个正交维度，与 ThingsBoard 一致。
const (
	AlarmActiveUnack  = "ACTIVE_UNACK"  // 已触发，未确认
	AlarmActiveAck    = "ACTIVE_ACK"    // 已触发，已确认
	AlarmClearedUnack = "CLEARED_UNACK" // 已恢复，未确认
	AlarmClearedAck   = "CLEARED_ACK"   // 已恢复，已确认
)

// 清除原因。
const (
	ClearAuto        = "auto"
	ClearManual      = "manual"
	ClearFalseReport = "false_report"
)

type Alarm struct {
	ID           int64    `db:"id" json:"id"`
	DeviceID     int64    `db:"device_id" json:"deviceId"`
	RuleNodeID   *int64   `db:"rule_node_id" json:"ruleNodeId"`
	LevelKey     string   `db:"level_key" json:"levelKey"`
	LevelRank    int64    `db:"level_rank" json:"levelRank"`
	Severity     string   `db:"severity" json:"severity"`
	Status       string   `db:"status" json:"status"`
	StartTs      int64    `db:"start_ts" json:"startTs"`
	AckTs        *int64   `db:"ack_ts" json:"ackTs"`
	AckBy        *string  `db:"ack_by" json:"ackBy"`
	ClearTs      *int64   `db:"clear_ts" json:"clearTs"`
	ClearedBy    *string  `db:"cleared_by" json:"clearedBy"`
	ClearReason  *string  `db:"clear_reason" json:"clearReason"`
	TriggerValue *float64 `db:"trigger_value" json:"triggerValue"`
	CurrentValue *float64 `db:"current_value" json:"currentValue"`
	Message      string   `db:"message" json:"message"`
	UpdatedAt    int64    `db:"updated_at" json:"updatedAt"`

	// 联表附加
	DeviceName string `db:"device_name" json:"deviceName"`
	DeviceCode string `db:"device_code" json:"deviceCode"`
}

// IsActive 是否处于生效态。
func (a *Alarm) IsActive() bool {
	return a.Status == AlarmActiveUnack || a.Status == AlarmActiveAck
}

// IsAcked 是否已确认。
func (a *Alarm) IsAcked() bool { return a.Status == AlarmActiveAck || a.Status == AlarmClearedAck }

// Transition 状态机：校验并计算目标状态。返回错误表示非法迁移。
// 迁移表：
//
//	ACTIVE_UNACK  --ack-->    ACTIVE_ACK
//	ACTIVE_ACK    --unack??   （不支持回退，避免审计失真）
//	ACTIVE_UNACK  --clear-->  CLEARED_UNACK
//	ACTIVE_ACK    --clear-->  CLEARED_ACK
//	ACTIVE_*      --false-->  CLEARED_*（按是否已确认定）
func (a *Alarm) Transition(action string) (string, error) {
	switch action {
	case "ack":
		if a.Status != AlarmActiveUnack {
			return "", fmt.Errorf("当前状态 %s 不允许确认", a.Status)
		}
		return AlarmActiveAck, nil
	case "clear":
		if !a.IsActive() {
			return "", fmt.Errorf("当前状态 %s 已解除，无需再次解除", a.Status)
		}
		if a.IsAcked() {
			return AlarmClearedAck, nil
		}
		return AlarmClearedUnack, nil
	case "false_report":
		if !a.IsActive() {
			return "", fmt.Errorf("当前状态 %s 已解除，无法标记误报", a.Status)
		}
		if a.IsAcked() {
			return AlarmClearedAck, nil
		}
		return AlarmClearedUnack, nil
	}
	return "", fmt.Errorf("未知动作 %q", action)
}

// ---------- 大屏 Dashboard ----------

type Dashboard struct {
	ID        int64  `db:"id" json:"id"`
	Name      string `db:"name" json:"name"`
	IsDefault Bool   `db:"is_default" json:"isDefault"`
	Layout    string `db:"layout" json:"-"`
	Widgets   string `db:"widgets" json:"-"`
	UpdatedAt int64  `db:"updated_at" json:"updatedAt"`

	LayoutList  []WidgetLayout `json:"layout" db:"-"`
	WidgetsList []Widget       `json:"widgets" db:"-"`
}

// WidgetLayout 栅格布局（12 列）。
type WidgetLayout struct {
	Key string `json:"key"`
	X   int    `json:"x"`
	Y   int    `json:"y"`
	W   int    `json:"w"`
	H   int    `json:"h"`
}

// Widget 组件定义：绑定设备/遥测键的图表或指标卡。
type Widget struct {
	Key       string `json:"key"`
	Type      string `json:"type"` // kpi / line / bar / gauge / map / alarm-list
	Title     string `json:"title"`
	DeviceID  *int64 `json:"deviceId"`
	Metric    string `json:"metric"`
	DeviceIDs []int64 `json:"deviceIds"`
}

// ---------- 统计 ----------

type AlarmStats struct {
	ActiveTotal int64            `json:"activeTotal"`
	UnackTotal  int64            `json:"unackTotal"`
	TodayTotal  int64            `json:"todayTotal"`
	ByLevel     map[string]int64 `json:"byLevel"`
	ByStatus    map[string]int64 `json:"byStatus"`
	MaxActiveLevel *string       `json:"maxActiveLevel"`
}
