package httpapi

import (
	"net/http"

	"waterlog-v3/api/internal/icm"
)

// GatewayHealth 是 ICM 集成网关的健康快照来源。
//
// 这里只声明「能拿到健康快照」这一件事，而不是直接依赖 *icm.Gateway：
// 网关是可选能力，未启用时根本不存在对象，Server 侧只该拿到一个
// nil 接口而不是一个「存在但没配置」的网关。这样「没启用」这件事
// 在 HTTP 层是显式的（返回 not_enabled），而不是靠猜 nil 字段。
type GatewayHealth interface {
	Health() icm.HealthStatus
}

// icmHealthResponse 是 /api/icm/health 的响应体。
//
// 内嵌 icm.HealthStatus 而不是逐字段抄一遍：网关的字段增删只改一处，
// 不会出现「网关加了字段但接口没跟上」这种两边对不上的情况。
// 额外补 status / message 是给人看的：enabled/degraded 这类布尔
// 组合对运维不直观，message 直接说明当前处于什么状态。
type icmHealthResponse struct {
	icm.HealthStatus
	// Status 三态：not_enabled / ok / degraded。
	Status string `json:"status"`
	// Message 状态说明，给运维与前端直接展示。
	Message string `json:"message"`
}

// icmHealth 暴露 ICM 集成网关的健康度。
//
// 放在「已登录即可」的只读段而不是公开段：健康快照里带着对方地址、
// 接入点、映射告警等内部集成状态，属于内部信息，不该匿名可读。
//
// 网关未启用时同样返回 200 + not_enabled，而不是 404：
// 端点本身存在、只是能力没开，404 会让前端误判成「接口没这个能力」。
func (s *Server) icmHealth(w http.ResponseWriter, r *http.Request) {
	if s.gw == nil {
		writeJSON(w, http.StatusOK, icmHealthResponse{
			HealthStatus: icm.HealthStatus{Enabled: false},
			Status:       "not_enabled",
			Message:      "ICM 集成网关未启用（未配置 WL_ICM_BASE_URL）",
		})
		return
	}
	h := s.gw.Health()
	out := icmHealthResponse{HealthStatus: h}
	switch {
	case !h.Enabled:
		out.Status = "not_enabled"
		out.Message = "ICM 集成网关未启用（未配置 WL_ICM_BASE_URL）"
	case h.Degraded:
		out.Status = "degraded"
		out.Message = "ICM 集成网关降级：最近一次同步失败，详见 lastError"
	default:
		out.Status = "ok"
		out.Message = "ICM 集成网关正常"
	}
	writeJSON(w, http.StatusOK, out)
}
