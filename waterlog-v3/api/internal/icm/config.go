// Package icm 实现「按对方原样复用」的出站调用层，对接黄岩区城市内涝基础平台
// （Infovision iCM 智慧城管平台 V3.0.0）。
//
// 职责边界（依据 docs/06-接口设计说明-对接黄岩区城市内涝基础平台.md）：
//   - 只做「① 出站复用」：按 ICM 原件的真实路径、真实字段名、真实协议调用。
//   - 不做协议适配网关 / 自研接口 / 前端 / 大屏：那些属于后面批次。
//   - v3 主干零改动：本包是独立单元，不改 router.go / respond.go / config.go，
//     也不改 domain 与前端；接入点只复用已有的 POST /api/ingest/telemetry。
//
// 配置全部走环境变量，且刻意不并入 api/internal/config：那是已上线进程的启动
// 配置，塞进去会动 Validate()、牵连部署脚本。本单元缺省即「不启用」。
package icm

import (
	"context"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config 是 ICM 复用单元的独立配置。零值 = 不启用。
type Config struct {
	BaseURL   string        // WL_ICM_BASE_URL，如 https://<host>；空 = 不启用
	Timeout   time.Duration // 单次请求超时
	PageSize  int           // 分页大小，上限 1000（设计文档 §3.3 差异 4）
	MaxPages  int           // 分页循环硬上限，防止对方 total 异常导致全量拉取
	Retry     int           // 可重试错误的最大重试次数（不含首次）
	RetryBase time.Duration // 退避基数

	TreeCode        string // R5/R7/R8，默认 "0"（国标树，§8 Q2 待对方确认）
	DeviceType      string // R1/R2 必填，真实取值待对方设备类型字典（§8 Q4）
	MonitorItem     string // 水位监测项编码，作为「动态字段名」出现在响应里（示例 "wl"）
	MonitorItemRain string // 雨量监测项编码，可选；空 = 不取雨量

	IngestURL   string // v3 已有写入端，默认 http://127.0.0.1:8200/api/ingest/telemetry
	IngestToken string // 复用 v3 已有的 WL_INGEST_TOKEN，不另造一套密钥

	Token TokenProvider // 应用认证插件位，见下方 EXT-POINT
}

// EXT-POINT(INTEGRATION): ICM V3.0.0 文档未提供应用认证 / Token 获取接口（§8 Q1）。
// 本单元不写死任何凭据。TokenProvider 是固定的注入契约：
// 返回可直接放进 Authorization 头的值（如 "Bearer xxx"）；返回空串表示本次不加头。
// 联调前由对方补充认证方式后，实现此接口并注入 Config.Token。
type TokenProvider interface {
	AccessToken(ctx context.Context) (string, error)
}

// TokenFunc 把普通函数适配成 TokenProvider，方便测试与临时接入。
type TokenFunc func(ctx context.Context) (string, error)

// AccessToken 实现 TokenProvider。
func (f TokenFunc) AccessToken(ctx context.Context) (string, error) { return f(ctx) }

// StaticToken 从环境变量 WL_ICM_TOKEN 读一个现成 token。
// 这是「对方已直接发放固定 token」时的最小实现，不冒充认证接口。
func StaticToken() TokenProvider {
	v := os.Getenv("WL_ICM_TOKEN")
	if v == "" {
		return nil
	}
	if !strings.HasPrefix(strings.ToLower(v), "bearer ") {
		v = "Bearer " + v
	}
	return TokenFunc(func(context.Context) (string, error) { return v, nil })
}

const (
	defaultTimeout     = 5 * time.Second
	defaultPageSize    = 500
	defaultMaxPages    = 200 // 500 * 200 = 10 万条上限，覆盖一次全量巡检足够
	defaultRetry       = 2
	defaultRetryBase   = time.Second
	defaultTreeCode    = "0"
	defaultDeviceType  = "waterLevelGauge" // 示例值；真实枚举待 R17 / §8 Q4
	defaultMonitorItem = "wl"
	defaultIngestURL   = "http://127.0.0.1:8200/api/ingest/telemetry"
)

// Load 从环境变量读取配置；缺失一律回落默认值，不因为写错一个数字就起不来
// （与 api/internal/config.Load 相同的容错口径）。
func Load() Config {
	return Config{
		BaseURL:         strings.TrimRight(envStr("WL_ICM_BASE_URL", ""), "/"),
		Timeout:         time.Duration(envInt("WL_ICM_TIMEOUT_MS", int(defaultTimeout/time.Millisecond))) * time.Millisecond,
		PageSize:        clamp(envInt("WL_ICM_PAGE_SIZE", defaultPageSize), 1, 1000),
		MaxPages:        clamp(envInt("WL_ICM_MAX_PAGES", defaultMaxPages), 1, 10000),
		Retry:           clamp(envInt("WL_ICM_RETRY", defaultRetry), 0, 5),
		RetryBase:       time.Duration(envInt("WL_ICM_RETRY_BASE_MS", int(defaultRetryBase/time.Millisecond))) * time.Millisecond,
		TreeCode:        envStr("WL_ICM_TREE_CODE", defaultTreeCode),
		DeviceType:      envStr("WL_ICM_DEVICE_TYPE", defaultDeviceType),
		MonitorItem:     envStr("WL_ICM_MONITOR_ITEM", defaultMonitorItem),
		MonitorItemRain: envStr("WL_ICM_MONITOR_ITEM_RAIN", ""),
		IngestURL:       envStr("WL_ICM_INGEST_URL", defaultIngestURL),
		IngestToken:     envStr("WL_INGEST_TOKEN", ""),
		Token:           StaticToken(),
	}.normalize()
}

// Enabled 表示是否允许发起出站调用。未配置地址时，任何调用都不会发生。
func (c Config) Enabled() bool { return strings.TrimSpace(c.BaseURL) != "" }

// normalize 补齐缺省值，让调用方可以只填关心的字段（测试里尤其有用）。
func (c Config) normalize() Config {
	if c.Timeout <= 0 {
		c.Timeout = defaultTimeout
	}
	if c.PageSize <= 0 {
		c.PageSize = defaultPageSize
	}
	if c.MaxPages <= 0 {
		c.MaxPages = defaultMaxPages
	}
	if c.Retry < 0 {
		c.Retry = 0
	}
	if c.RetryBase <= 0 {
		c.RetryBase = defaultRetryBase
	}
	if c.TreeCode == "" {
		c.TreeCode = defaultTreeCode
	}
	if c.DeviceType == "" {
		c.DeviceType = defaultDeviceType
	}
	if c.MonitorItem == "" {
		c.MonitorItem = defaultMonitorItem
	}
	if c.IngestURL == "" {
		c.IngestURL = defaultIngestURL
	}
	return c
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

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
