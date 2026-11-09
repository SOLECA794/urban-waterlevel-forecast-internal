package domain

// 预警处置闭环。
//
// 为什么除了「确认」还要有处置：真实值班不是点一下「知道了」就结束的。
// 一条预警的生命周期里，确认只是第一格；接下来是派给谁、有没有到场、
// 封没封路、是真内涝还是传感器抽风。这四件事分别对应：
//
//	assignee    派给谁
//	disposition 走到哪一步（open → dispatched → onsite → resolved / false_alarm）
//	alert_note  这中间说过什么（谁在什么时间因为什么做了什么）
//
// 与四态（ACTIVE_UNACK / ACTIVE_ACK / CLEARED_*）是两个轴，不能合：
// 四态回答「这条预警还成立吗」（由模型与规则决定），
// 处置回答「我们做了什么」（由人决定）。一条已经 CLEARED 的预警，
// 处置可能还停在 dispatched——水退了不等于现场处理完了。

// 处置五态。
const (
	DispositionOpen       = "open"
	DispositionDispatched = "dispatched"
	DispositionOnsite     = "onsite"
	DispositionResolved   = "resolved"
	DispositionFalseAlarm = "false_alarm"
)

// dispositionNext 是处置状态机。故意不允许 dispatched 直接回 open：
// 「已经派出去了」不能假装没发生，要退回去必须显式说明（这里选择不允许，
// 因为把已派单的记录改回未处理会污染值班审计）。
var dispositionNext = map[string][]string{
	DispositionOpen:       {DispositionDispatched, DispositionOnsite, DispositionResolved, DispositionFalseAlarm},
	DispositionDispatched: {DispositionOnsite, DispositionResolved, DispositionFalseAlarm},
	DispositionOnsite:     {DispositionResolved, DispositionFalseAlarm},
	DispositionResolved:   {DispositionOpen},
	DispositionFalseAlarm: {DispositionOpen},
}

var dispositionLabel = map[string]string{
	DispositionOpen:       "待处置",
	DispositionDispatched: "已派单",
	DispositionOnsite:     "已到场",
	DispositionResolved:   "已处置",
	DispositionFalseAlarm: "误报归档",
}

// ValidDisposition 判断 to 是否是已知的处置状态。
func ValidDisposition(to string) bool {
	_, ok := dispositionNext[to]
	return ok
}

// CanTransition 判断处置状态能否从 from 直接改为 to。
func CanTransition(from, to string) bool {
	for _, v := range dispositionNext[from] {
		if v == to {
			return true
		}
	}
	return false
}

// DispositionLabel 返回处置状态的中文名（未知状态返回空串，与既有行为一致）。
func DispositionLabel(s string) string { return dispositionLabel[s] }
