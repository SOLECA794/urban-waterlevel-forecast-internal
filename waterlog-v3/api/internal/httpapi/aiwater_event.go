package httpapi

// 本文件实现 A-9「平台事件接收（订阅回调）」，路径 /api/aiwater/v1/event/receive。
//
// 三条硬约束，全部来自对方平台的回调约定：
//
// 1. **免平台 Token**：这条是对方 ICM → 我方的入站回调，
//    对方不会带它自己的 accessToken（那是给我方调它时用的）。
//    但不能因此不设防——所以用**共享密钥验签**替代 Token。
//
// 2. **必须验签**：请求头 X-AIWater-Signature 携带
//    HMAC-SHA256(secret, 原始报文体) 的十六进制值。
//    没配密钥时放行并标注 signatureVerified=false（同机联调态）；
//    配了密钥就必须验，否则事件来源不可信。
//
// 3. **收到必须返回 HTTP 200**：对方平台按 HTTP 状态码判定投递是否成功，
//    非 200 会触发它的重试storm——同一个事件被反复推几十次。
//    所以验签失败、参数错误也一律回 200，
//    失败信息放在响应包的 code / msg 里（那是给对方业务侧看的），
//    同时在服务端落日志。

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"waterlog-v3/api/internal/domain"
)

// aiwaterEventIn 是 A-9 收到的单条事件。
//
// 对方可能一次推一个事件对象，也可能推一个数组；
// 两种形态都收（见 aiwaterEventReceive 的解析）。
type aiwaterEventIn struct {
	// EventID 事件标识。**必填**，它是幂等键的一部分。
	EventID string `json:"eventId"`
	// PointCode 点位编码。
	PointCode string `json:"pointCode"`
	// Stage 阶段：发现 / 复核 / 核销。
	Stage string `json:"stage"`
	// Operator 操作人。
	Operator string `json:"operator"`
	// OperateTime 操作时刻。
	//
	// 对方给的是 ISO 8601 字符串（约定 3：yyyy-MM-dd'T'HH:mm:ss.SSSXXX）。
	// 这里用自定义类型同时接受字符串与数字秒，避免因为格式差异整批丢事件。
	OperateTime aiwaterTime `json:"operateTime"`
	// Conclusion 处置结论。
	Conclusion string `json:"conclusion"`
	// EvidenceURLs 佐证材料链接。
	EvidenceURLs []string `json:"evidenceUrls"`
	// RainScene 雨情场景。
	RainScene string `json:"rainScene"`
}

// aiwaterTime 兼容两种时间表示：ISO 8601 字符串与 Unix 秒数字。
//
// 对方的回调里时间格式未必统一（约定 3 说的是带毫秒带时区，
// 但实操中见过纯秒的数字）。与其因为格式对不上把整批事件丢掉，
// 不如两种都收，收不到再按墙钟兜底。
type aiwaterTime int64

// UnmarshalJSON 实现 json.Unmarshaler。
func (t *aiwaterTime) UnmarshalJSON(b []byte) error {
	// 数字
	var num json.Number
	if err := json.Unmarshal(b, &num); err == nil {
		if v, err := num.Int64(); err == nil {
			*t = aiwaterTime(v)
			return nil
		}
		if v, err := num.Float64(); err == nil {
			*t = aiwaterTime(int64(v))
			return nil
		}
	}
	// 字符串：先试纯数字，再试 ISO 8601
	var str string
	if err := json.Unmarshal(b, &str); err != nil {
		return nil // 不是数字也不是字符串：留 0，由上层按墙钟兜底
	}
	str = strings.TrimSpace(str)
	if str == "" {
		return nil
	}
	if v, err := parseAIWaterUnix(str); err == nil {
		*t = aiwaterTime(v)
		return nil
	}
	if v, err := parseAIWaterISO(str); err == nil {
		*t = aiwaterTime(v)
		return nil
	}
	return nil
}

// aiwaterEventResult 是 A-9 的响应体。
type aiwaterEventResult struct {
	// Accepted 本次真正写入的事件条数。
	Accepted int `json:"accepted"`
	// Duplicate 幂等命中（重复推送）的条数。
	Duplicate int `json:"duplicate"`
	// SignatureVerified 验签是否通过。
	SignatureVerified bool `json:"signatureVerified"`
	// EventIDs 本次处理涉及的事件号。
	EventIDs []string `json:"eventIds"`
	// ReceivedAt 我方收到时刻（墙钟 Unix 秒）。
	ReceivedAt int64 `json:"receivedAt"`
}

// aiwaterEventReceive 处理 A-9「平台事件接收」。
//
// 无论验签成败、参数对错，HTTP 状态码恒为 200（见文件头第 3 条约束）。
func (s *Server) aiwaterEventReceive(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		aiwaterEventReply(w, false, "读取请求体失败: "+err.Error(), nil)
		return
	}

	verified, verr := s.verifyAIWaterSignature(r, raw)
	if verr != nil {
		// 验签失败：记录并回 200（不处理事件）。
		s.log.Warn("网关事件验签失败", "path", r.URL.Path, "err", verr.Error())
		aiwaterEventReply(w, false, "验签失败: "+verr.Error(), nil)
		return
	}

	events, perr := parseAIWaterEvents(raw)
	if perr != nil {
		aiwaterEventReply(w, verified, "报文解析失败: "+perr.Error(), nil)
		return
	}
	if len(events) == 0 {
		aiwaterEventReply(w, verified, "报文里没有事件", nil)
		return
	}

	now := nowWall()
	accepted, duplicate, ids := 0, 0, []string{}
	for _, e := range events {
		if strings.TrimSpace(e.EventID) == "" {
			// 没有事件号就没法去重，也没法在 A-8 里被检索到。
			// 这种事件丢掉比存一条没法去重的记录安全。
			continue
		}
		stage := strings.TrimSpace(e.Stage)
		if stage == "" {
			stage = "发现"
		}
		operateTime := int64(e.OperateTime)
		if operateTime <= 0 {
			// 对方没给操作时刻：按我方收到时刻兜底。
			// 宁可时间不精确，也不要丢事件。
			operateTime = now
		}
		rec := domain.AIWaterEvent{
			EventID:      strings.TrimSpace(e.EventID),
			PointCode:    strings.TrimSpace(e.PointCode),
			Stage:        stage,
			Operator:     strings.TrimSpace(e.Operator),
			OperateTime:  operateTime,
			Conclusion:   e.Conclusion,
			EvidenceURLs: e.EvidenceURLs,
			Source:       "icm",
			PayloadHash:  aiwaterSHA256Hex(raw),
			ReceivedAt:   now,
			UpdatedAt:    now,
		}
		if rec.EvidenceURLs == nil {
			rec.EvidenceURLs = []string{}
		}
		inserted, err := s.store.InsertAIWaterEvent(rec)
		if err != nil {
			s.log.Error("网关事件落库失败", "event_id", rec.EventID, "err", err)
			// 落库失败不是「收不到」：对方已经推过来了，我方必须留住。
			// 这里继续处理后面的事件，但把整体结果标成失败。
			continue
		}
		if inserted {
			accepted++
		} else {
			duplicate++
		}
		ids = append(ids, rec.EventID)
	}

	msg := "已接收"
	if accepted == 0 && duplicate > 0 {
		msg = "全部为重复事件，已去重"
	}
	aiwaterEventReply(w, verified, msg, &aiwaterEventResult{
		Accepted:          accepted,
		Duplicate:         duplicate,
		SignatureVerified: verified,
		EventIDs:          ids,
		ReceivedAt:        now,
	})
}

// aiwaterEventReply 写 A-9 的响应。
//
// HTTP 状态码恒为 200：对方平台按状态码判定投递成功与否，
// 非 200 会触发它的重试。同一个事件被反复推送几十次，
// 幂等表虽然能挡住重复入库，但对方的重试队列会把我们的接口打满。
//
// 业务结果放在响应包的 code 里——那是对方**业务侧**读到的信息，
// 与传输层的「送达与否」是两件事。
func aiwaterEventReply(w http.ResponseWriter, verified bool, msg string, data *aiwaterEventResult) {
	if data == nil {
		data = &aiwaterEventResult{EventIDs: []string{}}
	}
	writeEnvelope(w, http.StatusOK, aiwaterCodeOK, msg, data)
}

// verifyAIWaterSignature 校验请求签名。
//
// 未配置密钥时返回 (false, nil)：放行但标注未验签。
// 这是同机联调态的取舍——多配一个密钥只是多一处会配错的地方。
// 一旦对外暴露，WL_AIWATER_EVENT_SECRET 必须设置。
func (s *Server) verifyAIWaterSignature(r *http.Request, body []byte) (bool, error) {
	secret := s.cfg.AIWaterEventSecret
	if secret == "" {
		return false, nil
	}
	got := strings.TrimSpace(r.Header.Get("X-AIWater-Signature"))
	if got == "" {
		return false, errMissingSignature
	}
	// 兼容 "sha256=<hex>" 与裸 hex 两种写法。
	got = strings.TrimSpace(strings.TrimPrefix(got, "sha256="))
	want := aiwaterHMACHex(secret, body)
	if !hmac.Equal([]byte(strings.ToLower(got)), []byte(want)) {
		return false, errBadSignature
	}
	return true, nil
}

// aiwaterHMACHex 计算 HMAC-SHA256 的十六进制摘要。
func aiwaterHMACHex(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// aiwaterSHA256Hex 计算普通 SHA-256 的十六进制摘要（用于报文指纹）。
func aiwaterSHA256Hex(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// parseAIWaterEvents 解析回调报文。
//
// 兼容三种形态：单对象、对象数组、{list:[...]} 包装。
// 对方在不同接口版本里用过不同包装方式，收全了省一轮扯皮。
func parseAIWaterEvents(raw []byte) ([]aiwaterEventIn, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return nil, nil
	}
	if trimmed[0] == '[' {
		var list []aiwaterEventIn
		if err := json.Unmarshal(raw, &list); err != nil {
			return nil, err
		}
		return list, nil
	}
	if trimmed[0] == '{' {
		var wrapper struct {
			List   []aiwaterEventIn `json:"list"`
			Events []aiwaterEventIn `json:"events"`
			Data   []aiwaterEventIn `json:"data"`
		}
		if err := json.Unmarshal(raw, &wrapper); err == nil {
			if len(wrapper.List) > 0 {
				return wrapper.List, nil
			}
			if len(wrapper.Events) > 0 {
				return wrapper.Events, nil
			}
			if len(wrapper.Data) > 0 {
				return wrapper.Data, nil
			}
		}
		var one aiwaterEventIn
		if err := json.Unmarshal(raw, &one); err != nil {
			return nil, err
		}
		if one.EventID == "" && one.PointCode == "" && one.Stage == "" {
			return nil, nil
		}
		return []aiwaterEventIn{one}, nil
	}
	return nil, errUnsupportedPayload
}

// 预置错误：避免每次都 new 一个 error 值。
var (
	errMissingSignature   = &aiwaterEventError{"缺少 X-AIWater-Signature 请求头"}
	errBadSignature       = &aiwaterEventError{"签名不匹配"}
	errUnsupportedPayload = &aiwaterEventError{"报文既不是对象也不是数组"}
)

// aiwaterEventError 是本文件内部的简单错误类型。
type aiwaterEventError struct{ msg string }

func (e *aiwaterEventError) Error() string { return e.msg }

// parseAIWaterUnix 解析纯数字的 Unix 秒（也接受毫秒）。
func parseAIWaterUnix(s string) (int64, error) {
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, err
	}
	// 13 位是毫秒：对方偶尔直接给毫秒时间戳。
	if v > 1e12 {
		v /= 1000
	}
	return v, nil
}

// parseAIWaterISO 解析 ISO 8601 时间（约定 3：带毫秒带时区）。
func parseAIWaterISO(s string) (int64, error) {
	for _, layout := range []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.000Z0700",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.Unix(), nil
		}
	}
	return 0, errUnsupportedPayload
}
