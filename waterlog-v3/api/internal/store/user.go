package store

import (
	"database/sql"
	"errors"
	"strings"

	"waterlog-v3/api/internal/domain"
)

// ErrNoUser 表示账号不存在。service 层会把它翻译成统一的"账号或密码不正确"，
// 不向外暴露"这个账号存在但密码错了"——那是给撞库送情报。
var ErrNoUser = errors.New("no such user")

// UserRow 是带口令摘要的用户行。
//
// PwdHash 单独放在这个内嵌结构里而不是塞进 domain.User：domain 是要被
// JSON 序列化出去的，任何一次不小心的序列化都不该有机会漏出摘要。
type UserRow struct {
	domain.User
	PwdHash string
}

// CountUsers 返回账号总数，用于判断是否需要创建引导管理员。
func (s *Store) CountUsers() (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM app_user`).Scan(&n)
	return n, err
}

// UserByName 按用户名取账号（含摘要）。
func (s *Store) UserByName(username string) (*UserRow, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var (
		u        UserRow
		display  string
		role     string
		hash     string
		disabled int
		created  int64
		last     sql.NullInt64
	)
	err := s.db.QueryRow(
		`SELECT username, display_name, role, pwd_hash, disabled, created_at, last_login_at
		   FROM app_user WHERE username = ?`, username).
		Scan(&u.Username, &display, &role, &hash, &disabled, &created, &last)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNoUser
	}
	if err != nil {
		return nil, err
	}
	u.DisplayName = display
	u.Role = role
	u.RoleLabel = domain.RoleLabel(role)
	u.PwdHash = hash
	u.Disabled = disabled != 0
	u.CreatedAt = created
	if last.Valid {
		v := last.Int64
		u.LastLoginAt = &v
	}
	return &u, nil
}

// ListUsers 列出全部账号（不含摘要），按角色权重降序、再按用户名升序。
func (s *Store) ListUsers() ([]domain.User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(
		`SELECT username, display_name, role, disabled, created_at, last_login_at
		   FROM app_user`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.User{}
	for rows.Next() {
		var (
			u        domain.User
			display  string
			role     string
			disabled int
			created  int64
			last     sql.NullInt64
		)
		if err := rows.Scan(&u.Username, &display, &role, &disabled, &created, &last); err != nil {
			return nil, err
		}
		u.DisplayName = display
		u.Role = role
		u.RoleLabel = domain.RoleLabel(role)
		u.Disabled = disabled != 0
		u.CreatedAt = created
		if last.Valid {
			v := last.Int64
			u.LastLoginAt = &v
		}
		out = append(out, u)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// 排序放这里而不是 SQL：角色权重是业务概念（domain.RoleRank），
	// 让 SQL 认识它意味着要在 SQL 里再写一份同样的映射。
	sortUsers(out)
	return out, nil
}

func sortUsers(us []domain.User) {
	for i := 1; i < len(us); i++ {
		for j := i; j > 0; j-- {
			a, b := us[j-1], us[j]
			ra, rb := domain.RoleRank(a.Role), domain.RoleRank(b.Role)
			if ra > rb || (ra == rb && strings.ToLower(a.Username) <= strings.ToLower(b.Username)) {
				break
			}
			us[j-1], us[j] = us[j], us[j-1]
		}
	}
}

// InsertUser 新建账号。用户名已存在时返回 sqlite 的唯一约束错误，由 service 转 409。
func (s *Store) InsertUser(username, displayName, role, pwdHash string, now int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO app_user (username, display_name, role, pwd_hash, disabled, created_at)
		 VALUES (?, ?, ?, ?, 0, ?)`, username, displayName, role, pwdHash, now)
	return err
}

// UpdateUser 局部更新账号。传 nil 的字段保持原值。
//
// 用指针而不是零值判断"要不要改"：把 display_name 改成空字符串是合法操作，
// 用空串当"没传"会让人永远清不掉显示名。
func (s *Store) UpdateUser(username string, displayName, role, pwdHash *string, disabled *bool) error {
	sets := []string{}
	args := []any{}
	if displayName != nil {
		sets = append(sets, "display_name = ?")
		args = append(args, *displayName)
	}
	if role != nil {
		sets = append(sets, "role = ?")
		args = append(args, *role)
	}
	if pwdHash != nil {
		sets = append(sets, "pwd_hash = ?")
		args = append(args, *pwdHash)
	}
	if disabled != nil {
		sets = append(sets, "disabled = ?")
		args = append(args, boolInt(*disabled))
	}
	if len(sets) == 0 {
		return nil
	}
	args = append(args, username)
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE app_user SET `+strings.Join(sets, ", ")+` WHERE username = ?`, args...)
	return err
}

// TouchLogin 记录一次成功登录的时间。
func (s *Store) TouchLogin(username string, now int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE app_user SET last_login_at = ? WHERE username = ?`, now, username)
	return err
}

// InsertSession 落一条会话。
func (s *Store) InsertSession(tokenHash, username string, now, expiresAt int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO app_session (token_hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		tokenHash, username, now, expiresAt)
	return err
}

// SessionUser 返回未过期会话对应的用户名。
//
// 过期判断放在 SQL 里（expires_at > ?）而不是取回来再比：这样即使进程的
// 时钟被往前拨，过期的会话也不会因为一次比较失误而复活。
func (s *Store) SessionUser(tokenHash string, now int64) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var username string
	err := s.db.QueryRow(
		`SELECT username FROM app_session WHERE token_hash = ? AND expires_at > ?`,
		tokenHash, now).Scan(&username)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNoUser
	}
	return username, err
}

// DeleteSession 注销一条会话。
func (s *Store) DeleteSession(tokenHash string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM app_session WHERE token_hash = ?`, tokenHash)
	return err
}

// DeleteUserSessions 踢掉某账号的全部会话（改密码、停用账号时用）。
func (s *Store) DeleteUserSessions(username string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM app_session WHERE username = ?`, username)
	return err
}

// PruneSessions 清掉过期会话，避免表无限增长。
func (s *Store) PruneSessions(now int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.db.Exec(`DELETE FROM app_session WHERE expires_at <= ?`, now)
}
