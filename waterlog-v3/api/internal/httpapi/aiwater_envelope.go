package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"waterlog-v3/api/internal/service"
)

// 本文件是「AI 平台自研网关」的响应契约层，对应 /api/aiwater/v1/*。
//
// 为什么要单独一套、而不是复用 writeJSON / fail：
//
//	对方平台（ICM）约定的响应包是 {code, msg, data}，其中 code 是**字符串**"0"；
//	v3 原生接口约定的是「成功=裸 JSON、失败={"error":"..."}」。
//
// 这两套都是已上线的对外契约：v3 原生那套被 9 个前端页面和 openapi.yaml 依赖，
// 对方那套是对接要求。任何一边改动都会打破已经存在的东西。
// 所以网关自己写一套，不去动 writeJSON / fail / failErr。
//
// 字段命名：网关对外一律 camelCase（跟对方口径一致），
// 分页用 pageNo / pageSize，出参壳是 {total, pageNo, pageSize, list}。
// v3 原生接口的 snake_case 保持原样不动。

// 网关响应码。全部是字符串，与对方平台口径一致。
const (
	aiwaterCodeOK              = "0"
	aiwaterCodeBadRequest      = "400"
	aiwaterCodeUnauthorized    = "401"
	aiwaterCodeForbidden       = "403"
	aiwaterCodeNotFound        = "404"
	aiwaterCodeConflict        = "409"
	aiwaterCodeTooManyRequests = "429"
	aiwaterCodeInternal        = "500"
	aiwaterCodeUnavailable     = "503"
	aiwaterCodeBadGateway      = "502"
)

// aiwaterEnvelope 是网关的统一响应包。
//
// Data 在错误时写 null（不是省略字段）：对方按固定结构解析，
// 字段缺失和字段为 null 是两回事。
type aiwaterEnvelope struct {
	Code string `json:"code"`
	Msg  string `json:"msg"`
	Data any    `json:"data"`
}

// writeEnvelope 是网关所有响应的唯一出口。
func writeEnvelope(w http.ResponseWriter, httpStatus int, code, msg string, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(httpStatus)
	_ = json.NewEncoder(w).Encode(aiwaterEnvelope{Code: code, Msg: msg, Data: data})
}

// aiwaterOK 写成功响应。
func aiwaterOK(w http.ResponseWriter, data any) {
	writeEnvelope(w, http.StatusOK, aiwaterCodeOK, "success", data)
}

// aiwaterFail 写失败响应。code 是字符串码，httpStatus 是对应的 HTTP 状态码。
func aiwaterFail(w http.ResponseWriter, httpStatus int, code, msg string) {
	writeEnvelope(w, httpStatus, code, msg, nil)
}

// aiwaterError 把 service 层的错误翻译成网关响应。
//
// service.Error.Kind 已经带了「该回什么码」的意图，这里只做格式转换，
// 文案原样透出——对方和运维看到的都是业务原话，不是翻译腔。
func aiwaterError(w http.ResponseWriter, err error) {
	var se *service.Error
	if errors.As(err, &se) {
		switch se.Kind {
		case service.KindBadRequest:
			aiwaterFail(w, http.StatusBadRequest, aiwaterCodeBadRequest, se.Msg)
		case service.KindNotFound:
			aiwaterFail(w, http.StatusNotFound, aiwaterCodeNotFound, se.Msg)
		case service.KindConflict:
			aiwaterFail(w, http.StatusConflict, aiwaterCodeConflict, se.Msg)
		default:
			aiwaterFail(w, http.StatusInternalServerError, aiwaterCodeInternal, se.Msg)
		}
		return
	}
	aiwaterFail(w, http.StatusInternalServerError, aiwaterCodeInternal, err.Error())
}

// aiwaterPage 是网关统一的分页壳。
//
// total 是满足条件的总条数，list 是当前页数据。
// 对方分页从 1 开始，pageSize 默认 20、上限 1000。
type aiwaterPage[T any] struct {
	Total    int `json:"total"`
	PageNo   int `json:"pageNo"`
	PageSize int `json:"pageSize"`
	List     []T `json:"list"`
}

// aiwaterPaging 是从请求里解析出来的分页参数。
type aiwaterPaging struct {
	PageNo   int
	PageSize int
}

// aiwaterDefaultPageSize 与 aiwaterMaxPageSize 是分页口径。
const (
	aiwaterDefaultPageSize = 20
	aiwaterMaxPageSize     = 1000
)

// newPaging 造一份默认分页参数。
func newPaging() aiwaterPaging {
	return aiwaterPaging{PageNo: 1, PageSize: aiwaterDefaultPageSize}
}

// normalize 收敛越界参数：非法值回落默认，超限截断。
//
// 不对非法分页报错，是因为对方 SDK 偶尔会传 pageSize=0 或负数，
// 直接 400 会让对方的重试逻辑把我们打成风暴；回落默认值更稳。
func (p aiwaterPaging) normalize() aiwaterPaging {
	if p.PageNo <= 0 {
		p.PageNo = 1
	}
	if p.PageSize <= 0 {
		p.PageSize = aiwaterDefaultPageSize
	}
	if p.PageSize > aiwaterMaxPageSize {
		p.PageSize = aiwaterMaxPageSize
	}
	return p
}

// aiwaterPagingBody 是请求体里的分页字段。
//
// 对方约定是 POST + JSON，所以分页参数主要走 body；
// query 里的同名参数作为兜底（便于 curl 手工排查）。
type aiwaterPagingBody struct {
	PageNo   int `json:"pageNo"`
	PageSize int `json:"pageSize"`
}

// pagingFrom 合并 body 与 query 的分页参数，query 优先（显式覆盖）。
func pagingFrom(body aiwaterPagingBody, r *http.Request) aiwaterPaging {
	p := aiwaterPaging{PageNo: body.PageNo, PageSize: body.PageSize}
	if v := r.URL.Query().Get("pageNo"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			p.PageNo = n
		}
	}
	if v := r.URL.Query().Get("pageSize"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			p.PageSize = n
		}
	}
	return p.normalize()
}

// RequireAIWaterToken 保护网关的对外接口。
//
// 对方用 Authorization: Bearer {accessToken}，这里同时接受
// X-AIWater-Token 头，方便对方的回调通道（只能加自定义头、不能改
// Authorization 头时）复用同一套校验。
//
// token 为空时直接放行：同机部署时多配一个密钥只是多一处会配错的地方。
// 一旦对外暴露，这个值必须设置。
func RequireAIWaterToken(token string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if token == "" {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if subtle.ConstantTimeCompare([]byte(bearerToken(r)), []byte(token)) != 1 {
				aiwaterFail(w, http.StatusUnauthorized, aiwaterCodeUnauthorized, "网关令牌无效")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// bearerToken 从请求里取网关令牌。
func bearerToken(r *http.Request) string {
	if v := r.Header.Get("X-AIWater-Token"); v != "" {
		return strings.TrimSpace(v)
	}
	auth := r.Header.Get("Authorization")
	if auth == "" {
		return ""
	}
	// 只认 Bearer 形式；其他认证方案（如 Basic）不猜。
	if len(auth) > 7 && strings.EqualFold(auth[:7], "bearer ") {
		return strings.TrimSpace(auth[7:])
	}
	return ""
}

// aiwaterTimeMeta 是所有含时间出参都要带的时间标注。
//
// 这是**硬约束**：v3 内部跑的是 60 倍加速的仿真时钟（NowTS 取自遥测表
// 最大时间戳），而对方平台用真实时间。如果不标注，对方会把仿真时间
// 当成真实采集时间去算时序、算时效、算积水量，整条链路就废了。
//
// 所以每个含时间的响应都同时给出：
//   - timeBasis：simulated 表示这是仿真时钟下的时间
//   - issuedAt：仿真时钟秒
//   - wallClock：真实墙钟秒（Unix）
type aiwaterTimeMeta struct {
	// TimeBasis 时间基准：simulated / real。
	TimeBasis string `json:"timeBasis"`
	// IssuedAt 仿真时钟秒（60x 加速）。timeBasis=real 时它等于 wallClock。
	IssuedAt int64 `json:"issuedAt"`
	// WallClock 真实墙钟秒（Unix），对方按真实时间对齐用这个。
	WallClock int64 `json:"wallClock"`
}

// timeMetaOf 生成时间标注。
func (s *Server) timeMetaOf() aiwaterTimeMeta {
	return aiwaterTimeMeta{
		TimeBasis: "simulated",
		IssuedAt:  s.svc.NowTS(),
		WallClock: nowWall(),
	}
}

// nowWall 取真实墙钟秒。
//
// 会话 TTL、审计时间这类「人的时间」都用墙钟，不用仿真时钟：
// 60 倍加速下，12 小时的会话会在 12 分钟仿真后就过期。
func nowWall() int64 { return time.Now().Unix() }
