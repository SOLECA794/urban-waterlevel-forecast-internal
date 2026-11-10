// Package config 负责读取运行期配置。
//
// 所有配置都来自环境变量，默认值与 v2/v3 既有部署保持一致：
// 不设任何变量时，程序行为与改造前完全相同。
package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
)

// 默认值。改这里等于改部署默认行为，注意与 start.ps1 / 文档同步。
const (
	// DefaultHost 默认只听本机：开发/演示都在同一台机器上，不需要对外。
	DefaultHost           = "127.0.0.1"
	DefaultPort           = 8200
	DefaultDBPath         = "data/waterlog.db"
	DefaultEngineURL      = "http://127.0.0.1:8201"
	DefaultWebDir         = "../web/dist"
	DefaultLogFormat      = "text"
	DefaultPruneKeepHours = 48
	DefaultDataDir        = "data"
	// DefaultSessionTTLH 会话有效期（小时）。8 小时一班，12 小时留出交接余量。
	DefaultSessionTTLH = 12
	// DefaultBootstrapPassword 空库时创建的 admin 口令。
	//
	// 这是个"能跑起来"的默认值，不是"能上线"的默认值——部署时必须覆盖，
	// 日志里会明确提示这一点（见 cmd/waterlog-api/main.go）。
	DefaultBootstrapPassword = "admin123"
)

// Config 是 api 进程的全部可配置项。
type Config struct {
	// Host 监听地址。默认 127.0.0.1 —— 本机单机跑的时候没有理由把端口开到网络上；
	// 部署到服务器时由 WL_API_HOST=0.0.0.0 显式打开。
	Host string
	// Port 监听端口。
	Port int
	// DBPath SQLite 文件路径。
	DBPath string
	// EngineURL Python 引擎地址，规则/重训/演练等请求反向代理过去。
	EngineURL string
	// WebDir 前端构建产物目录，存在就由 Go 托管，不存在就退化成一句提示。
	WebDir string
	// LogFormat 日志格式：text（默认）或 json。
	LogFormat string
	// PruneKeepHours 遥测/决策/快照的保留时长。
	PruneKeepHours int
	// DataDir 启动时确保存在的本地数据目录。
	DataDir string
	// SessionTTLH 会话有效期（小时）。
	SessionTTLH int
	// BootstrapAdminPassword 空库时 admin 的初始口令。
	BootstrapAdminPassword string
	// IngestToken 保护 /api/ingest/*（引擎 → Go 的写入端）。
	//
	// 默认空 = 不校验。本机单机跑的时候，多配一个密钥只是多一处会配错的地方；
	// 一旦 API 与引擎跨机部署，这个值必须设置。
	//
	// 注意这里没有"会话签名密钥"：会话用的是存在库里的不透明随机令牌，
	// 不是签名 cookie，所以不需要一个服务端密钥来防伪造。
	IngestToken string
	// AIWaterToken 保护 /api/aiwater/v1/* 的对外网关接口。
	//
	// 默认空 = 不校验。本机单机跑的时候，多配一个密钥只是多一处会配错的地方；
	// 一旦网关对外暴露，这个值必须设置。
	AIWaterToken string
	// AIWaterEventSecret 是 A-9 事件接收端的共享密钥，用于 HMAC 验签。
	//
	// 与 AIWaterToken 分开是刻意的：A-9 是对方平台**推给我方**的入站回调，
	// 对方不会带它自己的 accessToken，只能靠共享密钥验明来源。
	// 留空时事件仍然接收，但响应里会标注 signatureVerified=false。
	AIWaterEventSecret string
}

// Load 从环境变量读取配置。变量缺失或无法解析时回落到默认值——
// 与改造前 envStr/envInt 的容错行为一致（不因为写错一个数字就起不来）。
func Load() Config {
	return Config{
		Host:                   envStr("WL_API_HOST", DefaultHost),
		Port:                   envInt("WL_API_PORT", DefaultPort),
		DBPath:                 envStr("WL_API_DB", DefaultDBPath),
		EngineURL:              envStr("WL_ENGINE_URL", DefaultEngineURL),
		WebDir:                 envStr("WL_WEB_DIR", DefaultWebDir),
		LogFormat:              envStr("WL_LOG_FORMAT", DefaultLogFormat),
		PruneKeepHours:         envInt("WL_PRUNE_KEEP_HOURS", DefaultPruneKeepHours),
		DataDir:                DefaultDataDir,
		SessionTTLH:            envInt("WL_SESSION_TTL_H", DefaultSessionTTLH),
		BootstrapAdminPassword: envStr("WL_BOOTSTRAP_ADMIN_PASSWORD", DefaultBootstrapPassword),
		IngestToken:            envStr("WL_INGEST_TOKEN", ""),
		AIWaterToken:           envStr("WL_AIWATER_TOKEN", ""),
		AIWaterEventSecret:     envStr("WL_AIWATER_EVENT_SECRET", ""),
	}
}

// Validate 在启动前校验配置，把"端口写错"这类错误挡在 listen 之前。
func (c Config) Validate() error {
	if c.Host == "" {
		return fmt.Errorf("WL_API_HOST 不能为空")
	}
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("WL_API_PORT 非法: %d", c.Port)
	}
	if c.DBPath == "" {
		return fmt.Errorf("WL_API_DB 不能为空")
	}
	u, err := url.Parse(c.EngineURL)
	if err != nil {
		return fmt.Errorf("WL_ENGINE_URL 非法: %w", err)
	}
	if u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("WL_ENGINE_URL 需形如 http://127.0.0.1:8201，当前: %q", c.EngineURL)
	}
	if c.PruneKeepHours <= 0 {
		return fmt.Errorf("WL_PRUNE_KEEP_HOURS 必须为正数，当前: %d", c.PruneKeepHours)
	}
	if c.SessionTTLH <= 0 || c.SessionTTLH > 24*30 {
		return fmt.Errorf("WL_SESSION_TTL_H 需在 1~720 小时之间，当前: %d", c.SessionTTLH)
	}
	if len(c.BootstrapAdminPassword) < 6 {
		return fmt.Errorf("WL_BOOTSTRAP_ADMIN_PASSWORD 至少 6 位（当前 %d 位）", len(c.BootstrapAdminPassword))
	}
	return nil
}

func envStr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
