package icm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// Client 是 ICM 出站调用客户端。
//
// 所有「与对方原件不一致」的协议差异都刻意收口在这一层，上层业务方法只写
// 对方真实的路径与字段名（设计文档 §3.2）：
//   - code 归一化：ICM 是字符串 "0"，个别接口混用数字 0（§3.3 差异 1）
//   - 分页壳：pageNo/pageSize/total 出参可能是 String（§3.3 差异 2）
//   - 时间：yyyy-MM-dd'T'HH:mm:ss.SSSXXX，含毫秒含时区（§3.3 差异 3）
//   - 重试：幂等读 2 次退避；code != "0" 属业务错误，不重试（§3.5）
//   - 链路头：X-Request-Id / X-Trace-Id 全链路透传（§4）
//   - 忽略未知字段：json.Unmarshal 默认行为，兼容对方后续加字段
type Client struct {
	cfg    Config
	http   *http.Client
	seq    atomic.Uint64
	reqID  func() string
	logger func(format string, args ...any)
}

// NewClient 构造客户端。cfg 会补齐缺省值；未配置 BaseURL 时调用方应先查
// cfg.Enabled()，不要在未启用状态下发起请求。
func NewClient(cfg Config) *Client {
	cfg = cfg.normalize()
	c := &Client{
		cfg:    cfg,
		http:   &http.Client{Timeout: cfg.Timeout},
		logger: func(string, ...any) {},
	}
	c.reqID = func() string {
		return fmt.Sprintf("icm-%d-%d", time.Now().UnixMilli(), c.seq.Add(1))
	}
	return c
}

// SetRequestIDFactory 替换链路 ID 生成器（测试或对接统一 tracing 时用）。
func (c *Client) SetRequestIDFactory(f func() string) {
	if f != nil {
		c.reqID = f
	}
}

// SetLogger 注入日志函数；不注入时静默（本单元不引入第三方日志依赖）。
func (c *Client) SetLogger(f func(format string, args ...any)) {
	if f != nil {
		c.logger = f
	}
}

// Config 返回实际生效的配置（已补齐缺省值）。
func (c *Client) Config() Config { return c.cfg }

// ---------------------------------------------------------------- 响应包

type envelope struct {
	Code json.RawMessage `json:"code"`
	Msg  string          `json:"msg"`
	Data json.RawMessage `json:"data"`
}

// codeOK 归一化：字符串 "0"、数字 0、数字 0.0 都判成功。
// 不能只凭 HTTP 200 判成功（§3.3 差异 1 / §7.1）。
func (e envelope) codeOK() bool {
	return normalizeCode(e.Code) == "0"
}

func (e envelope) codeStr() string {
	if s := normalizeCode(e.Code); s != "" {
		return s
	}
	return "<empty>"
}

func normalizeCode(raw json.RawMessage) string {
	s := strings.TrimSpace(string(raw))
	s = strings.Trim(s, `"`)
	if s == "" || s == "null" {
		return ""
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		// 数字 0 / 0.0 与字符串 "0" 统一成 "0"；非 0 保留原始写法便于诊断
		if f == 0 {
			return "0"
		}
		if f == float64(int64(f)) {
			return strconv.FormatInt(int64(f), 10)
		}
	}
	return s
}

// APIError 表示对方返回了业务失败（code != "0"）或 HTTP 层失败。
type APIError struct {
	Path       string
	Code       string
	Msg        string
	HTTPStatus int
}

func (e *APIError) Error() string {
	return fmt.Sprintf("ICM %s: code=%s http=%d msg=%s", e.Path, e.Code, e.HTTPStatus, e.Msg)
}

// Retryable 判断该失败是否值得重试：网络错误、429、5xx 重试；
// 业务 code != "0" 一律不重试（§3.5「code≠\"0\" 不重试，记日志」）。
func (e *APIError) Retryable() bool {
	if e.HTTPStatus == http.StatusTooManyRequests || e.HTTPStatus >= 500 {
		return true
	}
	return false
}

// ---------------------------------------------------------------- 统一调用

// Do 发起一次出站调用并把 data 解到 out。
//
//   - method 为 POST 时 in 作为 JSON body；为 GET 时 in 必须是 url.Values，作 query。
//   - out 传 nil 表示不关心 data（如 R12 回调方式订阅，对方 data 无返回值）。
//   - Token 通过 Config.Token 插件位注入；每次重放都重新取，便于 401 后自然刷新。
func (c *Client) Do(ctx context.Context, method, path string, in any, out any) error {
	if !c.cfg.Enabled() {
		return fmt.Errorf("ICM 复用单元未启用：未配置 WL_ICM_BASE_URL")
	}

	var bodyBytes []byte
	if method == http.MethodPost {
		b, err := json.Marshal(in)
		if err != nil {
			return fmt.Errorf("marshal request %s: %w", path, err)
		}
		bodyBytes = b
	}

	attempts := c.cfg.Retry + 1
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			// 指数退避，与 §3.5 建议的 1s/3s/10s 同量级
			backoff := c.cfg.RetryBase << (attempt - 1)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff):
			}
		}

		err := c.doOnce(ctx, method, path, bodyBytes, in, out)
		if err == nil {
			return nil
		}
		lastErr = err

		var ae *APIError
		if !asAPIError(err, &ae) || !ae.Retryable() {
			// 业务错误 / 参数错误不重试，记日志即可
			c.logger("icm call failed (no retry): %v", err)
			return err
		}
		c.logger("icm call failed (retry %d/%d): %v", attempt+1, attempts-1, err)
	}
	return lastErr
}

func asAPIError(err error, target **APIError) bool {
	if e, ok := err.(*APIError); ok {
		*target = e
		return true
	}
	return false
}

func (c *Client) doOnce(ctx context.Context, method, path string, bodyBytes []byte, in any, out any) error {
	u := c.cfg.BaseURL + path
	if method == http.MethodGet {
		if q, ok := in.(url.Values); ok && len(q) > 0 {
			u += "?" + q.Encode()
		}
	}

	var body io.Reader
	if method == http.MethodPost {
		body = bytes.NewReader(bodyBytes)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return fmt.Errorf("build request %s: %w", path, err)
	}
	req.Header.Set("Accept", "application/json")
	if method == http.MethodPost {
		req.Header.Set("Content-Type", "application/json")
	}

	rid := c.reqID()
	req.Header.Set("X-Request-Id", rid)
	req.Header.Set("X-Trace-Id", rid)

	// EXT-POINT(INTEGRATION): 应用认证 / Token 获取方式待对方补充（§8 Q1）。
	// 这里不写死任何凭据，只按 TokenProvider 契约取；未注入时不带认证头。
	if c.cfg.Token != nil {
		tok, err := c.cfg.Token.AccessToken(ctx)
		if err != nil {
			return &APIError{Path: path, Code: "TOKEN", Msg: "获取 accessToken 失败: " + err.Error()}
		}
		if tok != "" {
			req.Header.Set("Authorization", tok)
		}
	}

	resp, err := c.http.Do(req)
	if err != nil {
		// 网络错误按可重试处理
		return &APIError{Path: path, Code: "NETWORK", Msg: err.Error(), HTTPStatus: 503}
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return &APIError{Path: path, Code: "NETWORK", Msg: err.Error(), HTTPStatus: 503}
	}

	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return &APIError{Path: path, Code: "DECODE", Msg: fmt.Sprintf("响应不是 {code,msg,data}: %v", err), HTTPStatus: resp.StatusCode}
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &APIError{Path: path, Code: env.codeStr(), Msg: env.Msg, HTTPStatus: resp.StatusCode}
	}
	if !env.codeOK() {
		return &APIError{Path: path, Code: env.codeStr(), Msg: env.Msg, HTTPStatus: resp.StatusCode}
	}

	if out != nil && len(env.Data) > 0 && string(env.Data) != "null" {
		if err := json.Unmarshal(env.Data, out); err != nil {
			return &APIError{Path: path, Code: "DECODE", Msg: fmt.Sprintf("data 解析失败: %v", err), HTTPStatus: resp.StatusCode}
		}
	}
	return nil
}

// DoRaw 保留原始 data（供无标准分页壳的接口，如 R6 / R12 自行解析）。
func (c *Client) DoRaw(ctx context.Context, method, path string, in any) (json.RawMessage, error) {
	var raw json.RawMessage
	if err := c.Do(ctx, method, path, in, &raw); err != nil {
		return nil, err
	}
	return raw, nil
}

// ---------------------------------------------------------------- 分页

// flexInt 兼容 ICM 出参里 number 与 string number 两种写法（§3.3 差异 2）。
type flexInt int64

func (f *flexInt) UnmarshalJSON(b []byte) error {
	s := strings.Trim(strings.TrimSpace(string(b)), `"`)
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		// 个别实现会写成 "12.0"
		if v, ferr := strconv.ParseFloat(s, 64); ferr == nil {
			*f = flexInt(int64(v))
			return nil
		}
		return err
	}
	*f = flexInt(n)
	return nil
}

// pageEnvelope 是 ICM 标准分页壳；totalPage 仅 /api/nms/v1/vqd/list 等接口有。
type pageEnvelope[T any] struct {
	Total     flexInt `json:"total"`
	PageNo    flexInt `json:"pageNo"`
	PageSize  flexInt `json:"pageSize"`
	TotalPage flexInt `json:"totalPage"`
	List      []T     `json:"list"`
}

// fetchAll 按 §3.3 差异 4 做分页循环：pageNo 从 1 起，直到已取数 >= total
// 或本页 list 为空。带 MaxPages 硬上限，禁止无条件全量拉取。
//
// buildBody(pageNo) 返回该页的请求体，由调用方按对方真实字段名填充。
func fetchAll[T any](ctx context.Context, c *Client, path string, buildBody func(pageNo int) any) ([]T, error) {
	out := make([]T, 0)
	for page := 1; page <= c.cfg.MaxPages; page++ {
		var pe pageEnvelope[T]
		if err := c.Do(ctx, http.MethodPost, path, buildBody(page), &pe); err != nil {
			return out, err
		}
		out = append(out, pe.List...)
		if len(pe.List) == 0 {
			break
		}
		total := int64(pe.Total)
		if total > 0 && int64(len(out)) >= total {
			break
		}
		if pe.TotalPage > 0 && int64(page) >= int64(pe.TotalPage) {
			break
		}
	}
	return out, nil
}

// ---------------------------------------------------------------- 时间

// ICMTimeLayout 对应 ICM 原件 yyyy-MM-dd'T'HH:mm:ss.SSSXXX（含毫秒、含时区偏移）。
const ICMTimeLayout = "2006-01-02T15:04:05.000Z07:00"

var shanghai = func() *time.Location {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		// 容器里没有 tzdata 时退化成固定 +08:00，避免解析直接失败
		return time.FixedZone("CST", 8*3600)
	}
	return loc
}()

// FormatICMTime 生成出站时间字符串（带毫秒、Asia/Shanghai）。
func FormatICMTime(t time.Time) string {
	return t.In(shanghai).Format(ICMTimeLayout)
}

// ParseICMTime 解析入站时间，兼容「带毫秒 / 不带毫秒 / 无时区」三种写法，
// 统一按 Asia/Shanghai 归一化（§3.3 差异 3）。
func ParseICMTime(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, fmt.Errorf("空时间字符串")
	}
	layouts := []string{
		ICMTimeLayout,
		"2006-01-02T15:04:05Z07:00",
		time.RFC3339Nano,
	}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t.In(shanghai), nil
		}
	}
	// 无时区写法按对方所在时区解释
	if t, err := time.ParseInLocation("2006-01-02T15:04:05.000", s, shanghai); err == nil {
		return t, nil
	}
	if t, err := time.ParseInLocation("2006-01-02 15:04:05", s, shanghai); err == nil {
		return t, nil
	}
	return time.Time{}, fmt.Errorf("无法解析 ICM 时间 %q", s)
}
