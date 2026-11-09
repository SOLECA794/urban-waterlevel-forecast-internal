package service

import (
	"errors"
	"strings"
	"sync"
	"time"

	"waterlog-v3/api/internal/domain"
	"waterlog-v3/api/internal/platform/auth"
	"waterlog-v3/api/internal/store"
)

// ErrBadCredentials 是登录失败的统一错误。
//
// 故意不区分"账号不存在"和"密码错误"：区分了就等于给撞库一个免费的
// 用户名枚举接口。日志里会记具体原因，响应里不会。
var ErrBadCredentials = errors.New("账号或密码不正确")

// Auth 是账号与会话的业务层。
//
// 它不碰 HTTP：cookie 怎么设、401 怎么写，都在 httpapi 层。
// 这样"会话有效期"这类策略可以在 CLI、测试里复用，而不需要伪造一个 ResponseWriter。
type Auth struct {
	store     *store.Store
	sessionTTL time.Duration
	bootstrap string

	mu       sync.Mutex
	lastPrune time.Time
}

// NewAuth 构造鉴权服务。bootstrapPwd 只在库里一个账号都没有时使用。
func NewAuth(st *store.Store, sessionTTL time.Duration, bootstrapPwd string) *Auth {
	if sessionTTL <= 0 {
		sessionTTL = 12 * time.Hour
	}
	return &Auth{store: st, sessionTTL: sessionTTL, bootstrap: bootstrapPwd}
}

// EnsureBootstrap 在空库上创建引导账号 admin。
//
// 只在 CountUsers()==0 时动手：一旦有人建过账号，就不再注入默认口令——
// 否则每次重启都会把管理员密码改回默认值，那是个后门而不是便利。
func (a *Auth) EnsureBootstrap(now int64) (string, bool, error) {
	n, err := a.store.CountUsers()
	if err != nil {
		return "", false, err
	}
	if n > 0 {
		return "", false, nil
	}
	pwd := a.bootstrap
	if pwd == "" {
		pwd = "waterlog"
	}
	hash, err := auth.HashPassword(pwd)
	if err != nil {
		return "", false, err
	}
	if err := a.store.InsertUser("admin", "系统管理员", domain.RoleAdmin, hash, now); err != nil {
		return "", false, err
	}
	return pwd, true, nil
}

// SessionTTL 返回会话有效期，供 handler 设置 cookie Max-Age。
func (a *Auth) SessionTTL() time.Duration { return a.sessionTTL }

// Login 校验口令并签发会话令牌。
//
// 两个时钟参数不是冗余：会话有效期必须走墙钟（模拟器 60x 加速，用仿真时钟
// 算过期会让一次 12 小时的会话在 12 分钟内失效），而 last_login_at 是给人看的，
// 必须与界面上的其他时间在同一个时间轴上——否则账号页显示"11-11 登录"、
// 而预警页显示"10-21 触发"，看的人会以为系统错乱。
func (a *Auth) Login(username, password string, wallNow, simNow int64) (*domain.User, string, error) {
	username = strings.TrimSpace(username)
	row, err := a.store.UserByName(username)
	if errors.Is(err, store.ErrNoUser) {
		// 账号不存在时也跑一次摘要校验，把响应时间拉平，
		// 否则"快 = 账号不存在 / 慢 = 密码错"又成了一个枚举通道。
		_ = auth.VerifyPassword(
			"pbkdf2$120000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", password)
		return nil, "", ErrBadCredentials
	}
	if err != nil {
		return nil, "", err
	}
	if row.Disabled {
		return nil, "", errors.New("账号已停用，请联系管理员")
	}
	if !auth.VerifyPassword(row.PwdHash, password) {
		return nil, "", ErrBadCredentials
	}

	token, err := auth.NewToken()
	if err != nil {
		return nil, "", err
	}
	expires := wallNow + int64(a.sessionTTL.Seconds())
	if err := a.store.InsertSession(auth.TokenHash(token), row.Username, wallNow, expires); err != nil {
		return nil, "", err
	}
	_ = a.store.TouchLogin(row.Username, simNow)
	row.LastLoginAt = &simNow

	a.pruneSessions(wallNow)
	return &row.User, token, nil
}

// User 用令牌摘要换当前用户。会话过期、账号被停用都返回 ErrBadCredentials。
func (a *Auth) User(tokenHash string, now int64) (*domain.User, error) {
	username, err := a.store.SessionUser(tokenHash, now)
	if err != nil {
		return nil, ErrBadCredentials
	}
	row, err := a.store.UserByName(username)
	if err != nil {
		return nil, ErrBadCredentials
	}
	if row.Disabled {
		return nil, errors.New("账号已停用，请联系管理员")
	}
	return &row.User, nil
}

// Logout 注销一条会话。
func (a *Auth) Logout(tokenHash string) error {
	return a.store.DeleteSession(tokenHash)
}

// ListUsers 列出账号。
func (a *Auth) ListUsers() ([]domain.User, error) { return a.store.ListUsers() }

// CreateUser 建账号。用户名重复时返回冲突错误。
func (a *Auth) CreateUser(username, displayName, role, password string, now int64) (*domain.User, error) {
	username = strings.TrimSpace(username)
	if username == "" {
		return nil, badRequest("用户名不能为空")
	}
	if !domain.ValidRole(role) {
		return nil, badRequest("角色只能是 admin / operator / viewer")
	}
	if len(password) < 6 {
		return nil, badRequest("口令至少 6 位")
	}
	if _, err := a.store.UserByName(username); err == nil {
		return nil, conflict(errors.New("用户名已存在"))
	} else if !errors.Is(err, store.ErrNoUser) {
		return nil, internal(err)
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return nil, internal(err)
	}
	if displayName == "" {
		displayName = username
	}
	if err := a.store.InsertUser(username, displayName, role, hash, now); err != nil {
		return nil, internal(err)
	}
	row, err := a.store.UserByName(username)
	if err != nil {
		return nil, internal(err)
	}
	return &row.User, nil
}

// PatchUser 局部更新账号：显示名、角色、口令、启用状态。
//
// 两条硬约束写在这里而不是 handler 里：
//  1. 不能把最后一个可用的 admin 降级或停用——否则没人能再进系统。
//  2. 改口令或停用账号会踢掉该账号的全部会话——口令改了但旧 cookie 还能用，
//     等于没改。
func (a *Auth) PatchUser(username string, displayName, role, password *string, disabled *bool) (*domain.User, error) {
	row, err := a.store.UserByName(username)
	if err != nil {
		if errors.Is(err, store.ErrNoUser) {
			return nil, notFound("账号不存在")
		}
		return nil, internal(err)
	}
	if role != nil && !domain.ValidRole(*role) {
		return nil, badRequest("角色只能是 admin / operator / viewer")
	}

	losingAdmin := row.Role == domain.RoleAdmin &&
		((role != nil && *role != domain.RoleAdmin) || (disabled != nil && *disabled))
	if losingAdmin {
		users, err := a.store.ListUsers()
		if err != nil {
			return nil, internal(err)
		}
		alive := 0
		for _, u := range users {
			if u.Role == domain.RoleAdmin && !u.Disabled {
				alive++
			}
		}
		if alive <= 1 {
			return nil, conflict(errors.New("这是最后一个可用的管理员，不能降级或停用"))
		}
	}

	var hash *string
	if password != nil {
		if len(*password) < 6 {
			return nil, badRequest("口令至少 6 位")
		}
		h, err := auth.HashPassword(*password)
		if err != nil {
			return nil, internal(err)
		}
		hash = &h
	}
	if err := a.store.UpdateUser(username, displayName, role, hash, disabled); err != nil {
		return nil, internal(err)
	}
	if hash != nil || (disabled != nil && *disabled) {
		_ = a.store.DeleteUserSessions(username)
	}
	updated, err := a.store.UserByName(username)
	if err != nil {
		return nil, internal(err)
	}
	return &updated.User, nil
}

// pruneSessions 每小时最多清一次过期会话。放在登录时顺手做，
// 不额外起一个 goroutine——这个清理不急，谁登录谁扫地。
func (a *Auth) pruneSessions(now int64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	t := time.Now()
	if t.Sub(a.lastPrune) < time.Hour {
		return
	}
	a.lastPrune = t
	a.store.PruneSessions(now)
}
