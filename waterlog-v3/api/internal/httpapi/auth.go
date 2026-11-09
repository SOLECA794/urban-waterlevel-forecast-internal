package httpapi

import (
	"net/http"
	"time"

	"waterlog-v3/api/internal/platform/auth"
	"waterlog-v3/api/internal/service"
)

// login 校验口令并下发会话 cookie。
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	u, token, err := s.auth.Login(body.Username, body.Password, time.Now().Unix(), s.svc.NowTS())
	if err != nil {
		if err == service.ErrBadCredentials {
			fail(w, http.StatusUnauthorized, "账号或密码不正确")
			return
		}
		failErr(w, err)
		return
	}
	s.setSessionCookie(w, token)
	// 登录这一刻还没有会话，Authenticate 不会跑，所以要手动填审计占位——
	// 否则审计里只剩一条"登录，操作人为空"，而"谁登录的"恰恰是最该记的。
	if slot, ok := r.Context().Value(identitySlotKey).(*Identity); ok {
		*slot = Identity{
			Username:    u.Username,
			DisplayName: u.DisplayName,
			Role:        u.Role,
			RoleLabel:   u.RoleLabel,
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"user":       u,
		"expires_in": int(s.auth.SessionTTL().Seconds()),
	})
}

// logout 注销当前会话并清 cookie。
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(auth.CookieName); err == nil && c.Value != "" {
		_ = s.auth.Logout(auth.TokenHash(c.Value))
	}
	s.clearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// me 返回当前登录者，供前端启动时判断是否已登录。
func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	id := IdentityFrom(r.Context())
	if id == nil {
		fail(w, http.StatusUnauthorized, "未登录或会话已过期")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": id})
}

// setSessionCookie 下发会话 cookie。
//
// 这里刻意不设 Secure：本机跑的是 http://127.0.0.1，设了 Secure 浏览器
// 根本不会回传 cookie，登录会陷入死循环。生产走 TLS 时必须打开
// （deploy/nginx.conf 末尾的 TLS 段里已注明）。
// HttpOnly 一直开着——前端不需要读这个 cookie，JS 读不到就少一条 XSS 外带路径。
func (s *Server) setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     auth.CookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(s.auth.SessionTTL().Seconds()),
	})
}

func (s *Server) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     auth.CookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}
