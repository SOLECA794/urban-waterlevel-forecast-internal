package domain

// 角色与账号。
//
// 三个角色不是"权限等级"那么简单，它们对应三种完全不同的工作状态：
//
//	admin    系统管理员：定规则、换模型、管账号。一天点几次。
//	operator 值班员：确认预警、派单、推进处置、触发演练。一直在点。
//	viewer   只读：领导、外部门、复盘时的旁观者。只看不写。
//
// 把 operator 和 admin 合成一个角色是很常见的偷懒，代价是每次改规则
// 都要找管理员要账号——而规则改动恰恰是最需要值班员参与的事。

const (
	RoleAdmin    = "admin"
	RoleOperator = "operator"
	RoleViewer   = "viewer"
)

// RoleLabel 是角色的中文名，前端直接用，避免两边各写一份翻译。
var roleLabel = map[string]string{
	RoleAdmin:    "系统管理员",
	RoleOperator: "值班员",
	RoleViewer:   "只读",
}

// RoleLabel 返回角色中文名；未知角色原样返回（不隐藏异常值）。
func RoleLabel(role string) string {
	if s, ok := roleLabel[role]; ok {
		return s
	}
	return role
}

// ValidRole 判断角色名是否合法。
func ValidRole(role string) bool {
	_, ok := roleLabel[role]
	return ok
}

// RoleRank 给角色排序用（admin > operator > viewer）。
func RoleRank(role string) int {
	switch role {
	case RoleAdmin:
		return 3
	case RoleOperator:
		return 2
	case RoleViewer:
		return 1
	}
	return 0
}

// User 是一个账号。PwdHash 永远不出现在 JSON 里——前端不需要，泄露就是事故。
type User struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Role        string `json:"role"`
	RoleLabel   string `json:"role_label"`
	Disabled    bool   `json:"disabled"`
	CreatedAt   int64  `json:"created_at"`
	LastLoginAt *int64 `json:"last_login_at"`
}

// AuditEntry 是一条写操作留痕。
type AuditEntry struct {
	ID         int64  `json:"id"`
	At         int64  `json:"at"`
	Username   string `json:"username"`
	Role       string `json:"role"`
	Method     string `json:"method"`
	Path       string `json:"path"`
	Status     int    `json:"status"`
	DurationMS int64  `json:"duration_ms"`
	IP         string `json:"ip"`
	Summary    string `json:"summary"`
	RequestID  string `json:"request_id"`
}

// NotifyChannel 是一个推送渠道配置。
//
// inapp（站内弹窗）永远启用且不可关闭：它是"最后一定会到达"的那条路。
// 关掉站内只留 webhook，等于把预警的可靠性押在第三方可用性上。
type NotifyChannel struct {
	Name        string `json:"name"`
	Enabled     bool   `json:"enabled"`
	Endpoint    string `json:"endpoint"`
	Secret      string `json:"secret"`     // 出站前打码，见 service.MaskChannel
	MinLevel    string `json:"min_level"`
	DebounceMin int    `json:"debounce_min"`
	UpdatedAt   int64  `json:"updated_at"`
}

// Delivery 是一次推送尝试的结果。
type Delivery struct {
	ID      int64  `json:"id"`
	At      int64  `json:"at"`
	Channel string `json:"channel"`
	SiteID  string `json:"site_id"`
	Level   string `json:"level"`
	OK      bool   `json:"ok"`
	Detail  string `json:"detail"`
}
