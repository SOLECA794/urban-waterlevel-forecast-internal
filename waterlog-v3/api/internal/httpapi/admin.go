package httpapi

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"waterlog-v3/api/internal/domain"
)

// ---------------------------------------------------------------- 账号管理

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.auth.ListUsers()
	if err != nil {
		failErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users, "roles": roleCatalog()})
}

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username    string `json:"username"`
		DisplayName string `json:"display_name"`
		Role        string `json:"role"`
		Password    string `json:"password"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	u, err := s.auth.CreateUser(body.Username, body.DisplayName, body.Role, body.Password, s.svc.NowTS())
	if err != nil {
		failErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "user": u})
}

func (s *Server) patchUser(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "username")
	var body struct {
		DisplayName *string `json:"display_name"`
		Role        *string `json:"role"`
		Password    *string `json:"password"`
		Disabled    *bool   `json:"disabled"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	// 不允许把自己停用或降级：这不是权限问题，是"按下去就再也登不进来"的
	// 操作失误。真要交接，换个人来改。
	if id := IdentityFrom(r.Context()); id != nil && id.Username == name {
		if body.Disabled != nil && *body.Disabled {
			fail(w, http.StatusConflict, "不能停用自己的账号")
			return
		}
		if body.Role != nil && domain.RoleRank(*body.Role) < domain.RoleRank(id.Role) {
			fail(w, http.StatusConflict, "不能降低自己的角色")
			return
		}
	}
	u, err := s.auth.PatchUser(name, body.DisplayName, body.Role, body.Password, body.Disabled)
	if err != nil {
		failErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "user": u})
}

// roleCatalog 把角色清单发给前端，避免前端硬编码一份翻译。
func roleCatalog() []map[string]any {
	roles := []string{domain.RoleAdmin, domain.RoleOperator, domain.RoleViewer}
	out := make([]map[string]any, 0, len(roles))
	for _, r := range roles {
		out = append(out, map[string]any{"value": r, "label": domain.RoleLabel(r)})
	}
	return out
}

// ---------------------------------------------------------------- 审计

func (s *Server) listAudit(w http.ResponseWriter, r *http.Request) {
	hours, _ := strconv.Atoi(r.URL.Query().Get("hours"))
	if hours <= 0 || hours > 24*30 {
		hours = 24
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	username := strings.TrimSpace(r.URL.Query().Get("username"))
	since := s.svc.NowTS() - int64(hours*3600)

	rows, err := s.store.AuditEntries(since, username, limit)
	if err != nil {
		failErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": rows, "hours": hours})
}

// ---------------------------------------------------------------- 推送渠道

func (s *Server) getChannels(w http.ResponseWriter, r *http.Request) {
	chans, err := s.notifier.Channels()
	if err != nil {
		failErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"channels": chans,
		"levels":   []string{"blue", "yellow", "orange", "red"},
	})
}

func (s *Server) putChannel(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	var body struct {
		Enabled     bool   `json:"enabled"`
		Endpoint    string `json:"endpoint"`
		Secret      string `json:"secret"`
		MinLevel    string `json:"min_level"`
		DebounceMin int    `json:"debounce_min"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	c, err := s.notifier.UpdateChannel(domain.NotifyChannel{
		Name:        name,
		Enabled:     body.Enabled,
		Endpoint:    body.Endpoint,
		Secret:      body.Secret,
		MinLevel:    body.MinLevel,
		DebounceMin: body.DebounceMin,
	}, s.svc.NowTS())
	if err != nil {
		failErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "channel": c})
}

func (s *Server) listDeliveries(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	rows, err := s.notifier.Deliveries(limit)
	if err != nil {
		failErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deliveries": rows})
}

func (s *Server) testChannel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Channel string `json:"channel"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	ok, detail, err := s.notifier.Test(body.Channel, s.svc.NowTS())
	if err != nil {
		failErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": ok, "detail": detail})
}
