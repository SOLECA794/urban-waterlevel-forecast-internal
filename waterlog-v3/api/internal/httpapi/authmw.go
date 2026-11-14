package httpapi

import (
	"context"
	"crypto/subtle"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"

	"waterlog-v3/api/internal/domain"
	"waterlog-v3/api/internal/platform/auth"
	"waterlog-v3/api/internal/service"
	"waterlog-v3/api/internal/store"
)

// ctxKey 是本包私有的 context 键类型。
//
// 用自定义类型而不是字符串：字符串键会和别的包撞车，撞了之后
// "为什么这里取到的用户是别人的"极难查。
type ctxKey int

const (
	identityKey ctxKey = iota + 1
	// identitySlotKey 存的是一个 **可写的空位**，由 Audit 中间件放进去、
	// 由 Authenticate 中间件填上。
	//
	// 为什么要多这么一个键：Audit 在 Authenticate 的外层（它要包住整个请求，
	// 才能看到 handler 写完的 status），而 context 只能往下传不能往上回——
	// 外层中间件在 next.ServeHTTP 返回后读到的仍是它自己那份 context。
	// 传一个指针下去、让内层往里写，是唯一不引入全局状态的解法。
	identitySlotKey
)

// Identity 是已通过鉴权的调用者。
type Identity struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Role        string `json:"role"`
	RoleLabel   string `json:"role_label"`
}

// IdentityFrom 取出当前调用者；未鉴权时为 nil。
func IdentityFrom(ctx context.Context) *Identity {
	if v, ok := ctx.Value(identityKey).(*Identity); ok {
		return v
	}
	return nil
}

// Authenticate 校验会话 cookie 并把调用者放进 context。
//
// 会话过期用的是墙钟（time.Now），不是仿真时钟：会话是"人"的时间，
// 不该跟着 60x 加速的模拟器跑——否则一次 12 小时的会话会在 12 分钟仿真后失效。
func Authenticate(a *service.Auth) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			c, err := r.Cookie(auth.CookieName)
			if err != nil || c.Value == "" {
				fail(w, http.StatusUnauthorized, "未登录或会话已过期")
				return
			}
			u, err := a.User(auth.TokenHash(c.Value), time.Now().Unix())
			if err != nil {
				fail(w, http.StatusUnauthorized, err.Error())
				return
			}
			id := &Identity{
				Username:    u.Username,
				DisplayName: u.DisplayName,
				Role:        u.Role,
				RoleLabel:   u.RoleLabel,
			}
			if slot, ok := r.Context().Value(identitySlotKey).(*Identity); ok {
				*slot = *id
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), identityKey, id)))
		})
	}
}

// RequireRole 要求调用者至少达到某个角色权重。
//
// 用"至少"而不是"等于"：admin 天然能做 operator 的事，写死相等会逼着
// 管理员在每次确认预警前先切换角色。
func RequireRole(min string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := IdentityFrom(r.Context())
			if id == nil {
				fail(w, http.StatusUnauthorized, "未登录或会话已过期")
				return
			}
			if domain.RoleRank(id.Role) < domain.RoleRank(min) {
				fail(w, http.StatusForbidden,
					"当前角色（"+id.RoleLabel+"）无权执行该操作，需要"+domain.RoleLabel(min)+"及以上")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireIngestToken 保护引擎 → Go 的写入端。
//
// 不配 token 时直接放行：本机单机跑的时候，多配一个密钥只是多一处会配错的地方。
// 配了就严格比对——用常数时间比较，避免把密钥变成可逐字节试出来的东西。
func RequireIngestToken(token string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if token == "" {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got := r.Header.Get("X-Ingest-Token")
			if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
				fail(w, http.StatusUnauthorized, "ingest token 不正确")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// Audit 记录写操作留痕。
//
// 只记写操作：读接口一天几百次，记下来会把真正要查的那一条埋掉。
// 引擎推送（/api/ingest/*）也不记——那是机器的心跳，不是人的操作。
func Audit(log *slog.Logger, st *store.Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !isWriteMethod(r.Method) ||
				!strings.HasPrefix(r.URL.Path, "/api/") ||
				strings.HasPrefix(r.URL.Path, "/api/ingest/") {
				next.ServeHTTP(w, r)
				return
			}
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			start := time.Now()
			slot := &Identity{}
			next.ServeHTTP(ww, r.WithContext(context.WithValue(r.Context(), identitySlotKey, slot)))

			// 身份来自占位（Authenticate 填的），而不是 r.Context()：
			// 外层这份 context 里没有 identityKey。
			var id *Identity
			if slot.Username != "" {
				id = slot
			}
			e := domain.AuditEntry{
				At:         st.NowTS(),
				Method:     r.Method,
				Path:       r.URL.Path,
				Status:     ww.Status(),
				DurationMS: time.Since(start).Milliseconds(),
				IP:         clientIP(r),
				Summary:    summarize(r),
				RequestID:  middleware.GetReqID(r.Context()),
			}
			if id != nil {
				e.Username, e.Role = id.Username, id.Role
			}
			if err := st.InsertAudit(e); err != nil {
				log.Warn("审计写入失败", "path", r.URL.Path, "err", err)
			}
		})
	}
}

func isWriteMethod(m string) bool {
	switch m {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	}
	return false
}

// summarize 把 method+path 翻译成一句人话。
//
// 审计表里存的是路径，但复盘的人想看到的是"谁确认了哪条预警"，
// 而不是"谁 POST 了 /api/alerts/152/ack"。翻译放在写入时做，
// 以后改了路由文案，历史记录仍然是当时的说法——这正是审计该有的性质。
func summarize(r *http.Request) string {
	p := r.URL.Path
	switch {
	case strings.HasSuffix(p, "/ack"):
		return "确认预警"
	case strings.HasSuffix(p, "/assign"):
		return "派单预警"
	case strings.HasSuffix(p, "/disposition"):
		return "推进处置状态"
	case strings.HasSuffix(p, "/notes"):
		return "添加处置备注"
	case p == "/api/rules":
		return "修改研判规则"
	case p == "/api/rules/preview":
		return "预演规则影响"
	case p == "/api/models/adopt":
		return "切换生效模型"
	case p == "/api/retrain":
		return "触发模型重训"
	case strings.HasPrefix(p, "/api/sim/"):
		return "降雨过程注入"
	case p == "/api/auth/login":
		return "登录"
	case p == "/api/auth/logout":
		return "登出"
	case strings.HasPrefix(p, "/api/users"):
		return "账号管理"
	case strings.HasPrefix(p, "/api/notify/"):
		return "推送渠道管理"
	case strings.HasPrefix(p, "/api/aiwater/v1/"):
		return aiwaterAuditSummary(p)
	}
	return r.Method + " " + p
}

// aiwaterAuditSummary 把网关路径翻译成一句人话。
//
// 网关是对方平台在调我们，它没有我们的账号体系，
// 所以审计记录里的 username 会是空的——这没关系，
// 路径本身能说明是谁在什么时候动了什么。
func aiwaterAuditSummary(path string) string {
	switch {
	case strings.HasSuffix(path, "/model/versions"):
		return "网关切换模型版本"
	case strings.HasSuffix(path, "/prediction/task/submit"):
		return "网关提交预测任务"
	case strings.HasSuffix(path, "/event/receive"):
		return "网关接收平台事件"
	case strings.HasSuffix(path, "/config/rainrule"):
		return "网关查询雨情规则"
	}
	return "网关调用 " + path
}

func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.IndexByte(v, ','); i > 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	host := r.RemoteAddr
	if i := strings.LastIndexByte(host, ':'); i > 0 {
		return host[:i]
	}
	return host
}
