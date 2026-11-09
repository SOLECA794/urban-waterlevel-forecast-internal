package domain

import "fmt"

// 预警事件四态。这是"这条预警还成立吗"这条轴，由模型与规则决定：
//
//	(无) --raise--> ACTIVE_UNACK --ack--> ACTIVE_ACK
//	ACTIVE_* --clear--> CLEARED_UNACK --ack--> CLEARED_ACK
//
// 非法迁移一律拒绝（返回可读原因，由 handler 转 409）。
const (
	StateActiveUnack  = "ACTIVE_UNACK"
	StateActiveAck    = "ACTIVE_ACK"
	StateClearedUnack = "CLEARED_UNACK"
	StateClearedAck   = "CLEARED_ACK"
)

var levelRank = map[string]int{"none": 0, "blue": 1, "yellow": 2, "orange": 3, "red": 4}

// LevelRankOf 返回预警等级的排序权重：none < blue < yellow < orange < red。
// 未知等级按 none 处理（与既有行为一致）。
func LevelRankOf(level string) int { return levelRank[level] }

// AckTransition 返回「确认」动作后的下一状态。
// 已经确认过的返回错误，由上层转成 409，前端据此提示而不是静默。
func AckTransition(state string) (string, error) {
	switch state {
	case StateActiveUnack:
		return StateActiveAck, nil
	case StateClearedUnack:
		return StateClearedAck, nil
	case StateActiveAck, StateClearedAck:
		return "", fmt.Errorf("已确认，无需重复确认")
	default:
		return "", fmt.Errorf("非法状态 %s", state)
	}
}

// IsActiveState 判断该状态是否属于「仍成立」的活动态。
func IsActiveState(state string) bool {
	return state == StateActiveUnack || state == StateActiveAck
}
