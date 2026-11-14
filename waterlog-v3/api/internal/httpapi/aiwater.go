package httpapi

// 本文件实现「AI 平台自研网关」的第一批接口（A-1 ~ A-8），路径前缀 /api/aiwater/v1。
//
// 设计约束（来自 docs/06 §2.2 / §4）：
//
//	1. 对外响应包固定 {code:"0", msg, data}，code 是**字符串**；
//	2. 出参一律 camelCase，分页壳 {total, pageNo, pageSize, list}；
//	3. v3 内部跑的是 60 倍加速仿真时钟，凡含时间的响应必须带 timeBasis 标注；
//	4. 预警四级（blue/yellow/orange/red）对外映射为三级（low/medium/high），
//	   但原始四级在扩展字段里保留，信息不因映射而丢失。
//
// 边界：网关只做「协议差异归一化」，不重算业务。预测值、风险研判、规则、
// 模型版本全部来自 v3 已有能力（service / engine），网关负责换名字、换外壳、
// 换分级，不重新发明一套算法。

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"waterlog-v3/api/internal/domain"
)

// ---------------------------------------------------------------- 公共口径

// 对外三级风险等级。
const (
	aiwaterRiskLow    = "low"
	aiwaterRiskMedium = "medium"
	aiwaterRiskHigh   = "high"
)

// 预警四级 → 对外三级（docs/06 §6.2）。
//
// 映射只放在网关：v3 内部四态机与「只降不升」两道硬约束保持原样（ADR-0004）。
func aiwaterRiskOf(level string) string {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "yellow":
		return aiwaterRiskMedium
	case "orange", "red":
		return aiwaterRiskHigh
	default: // blue / none → 无风险也是低风险
		return aiwaterRiskLow
	}
}

// aiwaterMatchLevel 判断一条记录是否命中对方的等级过滤条件。
//
// 过滤条件同时接受两种写法：对方的三级（low/medium/high）与我方的四级
// （blue/yellow/orange/red）。只认一种的话，对方按自己字典传参就会查空。
func aiwaterMatchLevel(filter, level string) bool {
	f := strings.ToLower(strings.TrimSpace(filter))
	if f == "" {
		return true
	}
	l := strings.ToLower(strings.TrimSpace(level))
	switch f {
	case aiwaterRiskLow:
		return l == "blue" || l == "none"
	case aiwaterRiskMedium:
		return l == "yellow"
	case aiwaterRiskHigh:
		return l == "orange" || l == "red"
	}
	return f == l
}

// 预见期（分钟）→ 对外名（1h / 3h / 6h / 12h）。
//
// 与引擎 config.py 的 HORIZONS_MIN = (60, 180, 360, 720) 一一对应。
var aiwaterPeriods = map[string]int{
	"1h": 60, "3h": 180, "6h": 360, "12h": 720,
	"60": 60, "180": 180, "360": 360, "720": 720,
}

// aiwaterPeriodName 由分钟数反查对外名；查不到返回原样（不丢信息）。
func aiwaterPeriodName(min int) string {
	switch min {
	case 60:
		return "1h"
	case 180:
		return "3h"
	case 360:
		return "6h"
	case 720:
		return "12h"
	}
	return strconv.Itoa(min) + "m"
}

// aiwaterPeriodMinutes 把对方传的 period 列表解析成分钟数。
//
// 认 "1h" 与 "60" 两种写法；无法解析的项被跳过而不是报错——
// 对方多传一个我们不认的预见期，不该让整个查询失败。
func aiwaterPeriodMinutes(periods []string) []int {
	if len(periods) == 0 {
		return []int{60, 180, 360, 720}
	}
	seen := map[int]bool{}
	out := []int{}
	for _, p := range periods {
		key := strings.ToLower(strings.TrimSpace(p))
		m, ok := aiwaterPeriods[key]
		if !ok {
			continue
		}
		if seen[m] {
			continue
		}
		seen[m] = true
		out = append(out, m)
	}
	if len(out) == 0 {
		return []int{60, 180, 360, 720}
	}
	sort.Ints(out)
	return out
}

// aiwaterThresholdOf 取某等级对应的**绝对**阈值。
//
// 引擎侧的 thresholds 是「相对基线的水深」（config.py 明确写了这一点），
// 对外要给绝对高程，所以要加回 baseLevel。
func aiwaterThresholdOf(meta domain.SiteMeta, level string) (float64, bool) {
	idx := -1
	switch strings.ToLower(level) {
	case "blue":
		idx = 0
	case "yellow":
		idx = 1
	case "orange":
		idx = 2
	case "red":
		idx = 3
	}
	if idx < 0 || idx >= len(meta.Thresholds) {
		return 0, false
	}
	return meta.BaseLevel + meta.Thresholds[idx], true
}

// aiwaterRiskFromDepth 按水深落在哪一档，反推三级风险。
//
// 用的是**站点阈值**而不是告警等级：对 A-1 来说，逐点逐预见期给出风险
// 比给一个站点级告警等级更有用——同一站点 1h 可能安全、12h 可能越橙。
func aiwaterRiskFromDepth(meta domain.SiteMeta, level float64) (string, string) {
	depth := level - meta.BaseLevel
	switch {
	case len(meta.Thresholds) >= 4 && depth >= meta.Thresholds[3]:
		return aiwaterRiskHigh, "red"
	case len(meta.Thresholds) >= 3 && depth >= meta.Thresholds[2]:
		return aiwaterRiskHigh, "orange"
	case len(meta.Thresholds) >= 2 && depth >= meta.Thresholds[1]:
		return aiwaterRiskMedium, "yellow"
	case len(meta.Thresholds) >= 1 && depth >= meta.Thresholds[0]:
		return aiwaterRiskLow, "blue"
	}
	return aiwaterRiskLow, "none"
}

// aiwaterConfidence 由置信带相对宽度换算出的 0~1 置信度。
//
// 置信带是 level ± 1.6449·σ（引擎里的 90% 区间），
// 相对水位越窄说明越可信：confidence = 1 / (1 + 半宽比)。
//
// 公式写在代码里而不是让对方自己算，是因为对方那边没有 σ；
// 我们给出结论，对方直接用，省得两边的口径对不上。
func aiwaterConfidence(level, sigma float64) float64 {
	denom := level
	if denom < 0 {
		denom = -denom
	}
	if denom < 0.1 {
		denom = 0.1
	}
	ratio := 1.6449 * sigma / denom
	c := 1.0 / (1.0 + ratio)
	if c < 0 {
		return 0
	}
	if c > 1 {
		return 1
	}
	return c
}

// aiwaterListData 是带时间标注的列表响应体。
//
// 嵌两个结构体而不是拼 map：字段名、JSON tag、类型都由编译器保证，
// 拼 map 的话少写一个字段要到运行时才发现。
type aiwaterListData[T any] struct {
	aiwaterPage[T]
	aiwaterTimeMeta
}

// aiwaterNewTaskID 生成任务标识。
//
// 用 crypto/rand 而不是时间戳：同一秒内提交两个任务时，
// 时间戳会撞。撞了会导致两个请求查到同一个 taskId，对方那边的任务数对不上。
func aiwaterNewTaskID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		// rand 失败是极端情况；退化成时间戳也比直接返回空串强。
		return "task-" + strconv.FormatInt(nowWall(), 10)
	}
	return "task-" + hex.EncodeToString(b[:])
}

// ---------------------------------------------------------------- A-1 预测结果

// aiwaterPredictionQuery 是 A-1 的入参。
type aiwaterPredictionQuery struct {
	// PointCode 单点位查询（与 PointCodes 二选一）。
	PointCode string `json:"pointCode"`
	// PointCodes 多点位查询。为空时返回全部站点。
	PointCodes []string `json:"pointCodes"`
	// Period 预见期列表：1h / 3h / 6h / 12h。为空时返回全部四个。
	Period []string `json:"period"`
	// BeginTime / EndTime 时间区间（仿真时钟秒）。当前实现按「预测目标时刻」过滤。
	BeginTime int64 `json:"beginTime"`
	EndTime   int64 `json:"endTime"`
	aiwaterPagingBody
}

// aiwaterPredictionResult A-1 的响应体。
type aiwaterPredictionResult struct {
	aiwaterListData[domain.AIWaterPrediction]
	// ModelVersion 本批结果的模型版本，便于对方按版本对齐。
	ModelVersion string `json:"modelVersion"`
}

// aiwaterPrediction 处理 A-1「水位趋势预测结果查询」。
//
// 数据来源是 v3 内存里的最新预测快照（service.Forecast）。
// 快照由引擎每 60 秒推一次，所以这里返回的是**最近一轮**的结果，
// 不是任意历史时刻的查询——历史查询走 v3 原生的 /api/eval/pairs 与 /api/sites/{id}/history。
//
// beginTime/endTime 按「预测目标时刻」过滤，即 predictTime 落在区间内的行才返回。
func (s *Server) aiwaterPrediction(w http.ResponseWriter, r *http.Request) {
	var q aiwaterPredictionQuery
	if !decodeJSON(w, r, &q) {
		return
	}
	paging := pagingFrom(q.aiwaterPagingBody, r)

	fc := s.svc.Forecast()
	if fc == nil {
		// 没有预测快照不是「出错」，是「还没算出来」。
		// 但也不能返回空列表装作正常——那会让对方以为「没有风险」。
		// 503 + 明确文案，对方侧就会显示「预测滞后」。
		aiwaterFail(w, http.StatusServiceUnavailable, aiwaterCodeUnavailable,
			"预测结果尚未生成（引擎尚未推送首轮预测），请稍后重试")
		return
	}

	want := map[string]bool{}
	for _, c := range q.PointCodes {
		if c = strings.TrimSpace(c); c != "" {
			want[c] = true
		}
	}
	if p := strings.TrimSpace(q.PointCode); p != "" {
		want[p] = true
	}
	periods := aiwaterPeriodMinutes(q.Period)

	rows := s.buildPredictions(fc, want, periods, q.BeginTime, q.EndTime)

	// 分页在内存里做：预测快照一轮只有站点数 × 4 个预见期的量级（几十行），
	// 引入游标分页换来的复杂度在这个量级上不划算。
	total := len(rows)
	page := sliceAIWater(rows, paging)
	if page == nil {
		page = []domain.AIWaterPrediction{}
	}
	aiwaterOK(w, aiwaterPredictionResult{
		aiwaterListData: aiwaterListData[domain.AIWaterPrediction]{
			aiwaterPage:     aiwaterPage[domain.AIWaterPrediction]{Total: total, PageNo: paging.PageNo, PageSize: paging.PageSize, List: page},
			aiwaterTimeMeta: s.timeMetaOf(),
		},
		ModelVersion: fc.ModelVersion,
	})
}

// buildPredictions 把 v3 的预测快照转成对外的预测行。
func (s *Server) buildPredictions(
	fc *domain.ForecastPayload,
	want map[string]bool,
	periods []int,
	beginTime, endTime int64,
) []domain.AIWaterPrediction {
	allowed := map[int]bool{}
	for _, m := range periods {
		allowed[m] = true
	}

	rows := []domain.AIWaterPrediction{}
	for siteID, sf := range fc.Sites {
		if len(want) > 0 && !want[siteID] {
			continue
		}
		meta, ok := s.svc.Site(siteID)
		if !ok {
			// 站点清单与预测快照对不上：跳过而不是造一条没有基线的数据。
			// 没有 baseLevel 就没法算水深，也就没法算阈值与风险等级。
			continue
		}
		for _, h := range sf.Horizons {
			if !allowed[h.HorizonMin] {
				continue
			}
			predictTime := fc.IssuedAt + int64(h.HorizonMin)*60
			if beginTime > 0 && predictTime < beginTime {
				continue
			}
			if endTime > 0 && predictTime > endTime {
				continue
			}
			risk, warnLevel := aiwaterRiskFromDepth(meta, h.Level)
			period := aiwaterPeriodName(h.HorizonMin)
			rows = append(rows, domain.AIWaterPrediction{
				PointCode:    siteID,
				Period:       period,
				PredictTime:  predictTime,
				PredictLevel: h.Level,
				RiskLevel:    risk,
				Confidence:   aiwaterConfidence(h.Level, h.Sigma),
				ModelVersion: fc.ModelVersion,
				Revision:     sf.NowLevel + h.DeltaRaw,
				// 幂等键按「点位 + 时段 + 版本号」三要素构造，与表五 R-06
				// 的「点位 + 时段 + 版本号」幂等写入口径一致。
				// 刻意不把 issuedAt 拼进键里：发布时刻每轮都变，
				// 掺进去之后同一份修正每次都会生成新键，幂等就失效了。
				CorrectionID: fmt.Sprintf("%s:%s:%s", siteID, period, fc.ModelVersion),
				WarnLevel:    warnLevel,
				Lower:        h.Lower,
				Upper:        h.Upper,
				Sigma:        h.Sigma,
				Correction:   h.Corrected,
				Gain:         h.Gain,
				Reason:       h.Reason,
			})
		}
	}
	// 排序：先按点位、再按预见期，保证对方拿到的顺序是稳定的。
	// map 遍历顺序是随机的，不排序的话同一份数据每次返回的行序都不一样，
	// 对方做增量比对会得到一堆假差异。
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].PointCode != rows[j].PointCode {
			return rows[i].PointCode < rows[j].PointCode
		}
		return rows[i].PredictTime < rows[j].PredictTime
	})
	return rows
}

// sliceAIWater 按分页参数切出一页。越界时返回空片而不是 panic。
func sliceAIWater[T any](rows []T, p aiwaterPaging) []T {
	start := (p.PageNo - 1) * p.PageSize
	if start < 0 || start >= len(rows) {
		return []T{}
	}
	end := start + p.PageSize
	if end > len(rows) {
		end = len(rows)
	}
	return rows[start:end]
}

// ---------------------------------------------------------------- A-2 风险实时

// aiwaterRiskQuery 是 A-2 的入参。
type aiwaterRiskQuery struct {
	// PointCode 点位编码（与 RegionIndexCode 二选一）。
	PointCode string `json:"pointCode"`
	// RegionIndexCode 区域编码（与 PointCode 二选一）。
	//
	// v3 没有区域层级模型，站点自带 district 字段；
	// 这里按 district 匹配，命中该区域下的全部站点。
	RegionIndexCode string `json:"regionIndexCode"`
	// Level 风险等级过滤：low / medium / high。
	Level string `json:"level"`
}

// aiwaterRiskSite 是 A-2 的一行。
type aiwaterRiskSite struct {
	PointCode string `json:"pointCode"`
	// RiskLevel 对外三级风险。
	RiskLevel string `json:"riskLevel"`
	// CurrentLevel 当前实测水位（m）。
	CurrentLevel float64 `json:"currentLevel"`
	// PredictLevel 预测峰值水位（m）。
	PredictLevel float64 `json:"predictLevel"`
	// RiskTime 风险判定时刻（仿真时钟秒）。
	RiskTime int64 `json:"riskTime"`
	// RuleID 命中的规则标识。
	RuleID string `json:"ruleId"`
	// RainScene 雨情场景。
	//
	// v3 没有雨情场景模型（条款 8-1 明确是留白），
	// 这里固定填 unspecified 而不是编一个——宁可让对方知道「没有」，
	// 也不要给一个看起来像真的枚举值。
	RainScene string `json:"rainScene"`
	// AppliedThreshold 本次适用的阈值（绝对高程 m）。
	AppliedThreshold float64 `json:"appliedThreshold"`

	// ---- 扩展字段 ----
	// WarnLevel 我方原始四级预警等级。
	WarnLevel string `json:"warnLevel"`
	// SiteName 站点名。
	SiteName string `json:"siteName"`
	// District 所属区域。
	District string `json:"district"`
	// WarnScore 研判评分 0~1。
	WarnScore float64 `json:"warnScore"`
	// DurationMin 超阈持续分钟数。
	DurationMin int `json:"durationMin"`
	// SlopeMH 水位变化速率（m/h）。
	SlopeMH float64 `json:"slopeMH"`
	// Reason 研判原因（可读文案）。
	Reason string `json:"reason"`
}

// aiwaterRiskResult 是 A-2 的响应体。
type aiwaterRiskResult struct {
	List []aiwaterRiskSite `json:"list"`
	aiwaterTimeMeta
	// Total 命中条数（不分页，全量返回）。
	Total int `json:"total"`
}

// aiwaterRiskRealtime 处理 A-2「风险等级实时查询」。
//
// 只有**当前存在预警**的站点才会出现在结果里。
// 对方文档写明「无风险返回空列表非报错」——如果把无预警站点也塞进来
// （riskLevel=low），对方拿到的是一长串「低风险」，而不是他们要的空列表。
func (s *Server) aiwaterRiskRealtime(w http.ResponseWriter, r *http.Request) {
	var q aiwaterRiskQuery
	if !decodeJSON(w, r, &q) {
		return
	}

	sites, now, err := s.svc.Overview()
	if err != nil {
		aiwaterError(w, err)
		return
	}

	fc := s.svc.Forecast()
	issuedAt := now
	if fc != nil {
		issuedAt = fc.IssuedAt
	}

	list := []aiwaterRiskSite{}
	for _, row := range sites {
		if row.WarnLevel == "" || row.WarnLevel == "none" {
			continue // 没有预警 = 没有风险，不进列表
		}
		if pc := strings.TrimSpace(q.PointCode); pc != "" && row.SiteID != pc {
			continue
		}
		if rc := strings.TrimSpace(q.RegionIndexCode); rc != "" && row.District != rc {
			continue
		}
		if !aiwaterMatchLevel(q.Level, row.WarnLevel) {
			continue
		}
		meta, ok := s.svc.Site(row.SiteID)
		threshold := 0.0
		if ok {
			if th, found := aiwaterThresholdOf(meta, row.WarnLevel); found {
				threshold = th
			}
		}
		list = append(list, aiwaterRiskSite{
			PointCode:        row.SiteID,
			RiskLevel:        aiwaterRiskOf(row.WarnLevel),
			CurrentLevel:     row.Level,
			PredictLevel:     row.PeakValue,
			RiskTime:         issuedAt,
			RuleID:           "rule-" + row.SiteID + "-" + row.WarnLevel,
			RainScene:        "unspecified",
			AppliedThreshold: threshold,
			WarnLevel:        row.WarnLevel,
			SiteName:         row.Name,
			District:         row.District,
			WarnScore:        row.WarnScore,
			DurationMin:      row.Duration,
			SlopeMH:          row.SlopeMH,
			Reason:           row.Reason,
		})
	}

	aiwaterOK(w, aiwaterRiskResult{List: list, aiwaterTimeMeta: s.timeMetaOf(), Total: len(list)})
}

// ---------------------------------------------------------------- A-3 预警记录

// aiwaterWarningQuery 是 A-3 的入参。
type aiwaterWarningQuery struct {
	// RegionIndexCode 区域编码（按站点所属区域过滤）。
	RegionIndexCode string `json:"regionIndexCode"`
	// PointCode 点位编码过滤。
	PointCode string `json:"pointCode"`
	// Level 等级过滤，接受三级或四级。
	Level string `json:"level"`
	// BeginTime / EndTime 触发时刻区间（仿真时钟秒）。
	BeginTime int64 `json:"beginTime"`
	EndTime   int64 `json:"endTime"`
	// Status 状态过滤：active / acknowledged / cleared。
	Status string `json:"status"`
	aiwaterPagingBody
}

// aiwaterAlertRecord 是 A-3 的一行。
type aiwaterAlertRecord struct {
	// WarningID 预警编号（我方事件 ID）。
	WarningID string `json:"warningId"`
	// PointCode 点位编码。
	PointCode string `json:"pointCode"`
	// Level 对外三级预警等级。
	Level string `json:"level"`
	// TriggerValue 触发时的水位值（m）。
	TriggerValue float64 `json:"triggerValue"`
	// Threshold 适用的阈值（绝对高程 m）。
	Threshold float64 `json:"threshold"`
	// RainScene 雨情场景（v3 无此模型，固定 unspecified）。
	RainScene string `json:"rainScene"`
	// TriggerTime 触发时刻（仿真时钟秒）。
	TriggerTime int64 `json:"triggerTime"`
	// Status 预警状态。
	Status string `json:"status"`
	// EventID 事件标识，与 A-8 的生命周期记录串联。
	EventID string `json:"eventId"`

	// ---- 扩展字段 ----
	// WarnLevel 我方原始四级等级。
	WarnLevel string `json:"warnLevel"`
	// State 我方四态机的原始状态。
	State string `json:"state"`
	// SiteName 站点名。
	SiteName string `json:"siteName"`
	// District 所属区域。
	District string `json:"district"`
	// Score 研判评分。
	Score float64 `json:"score"`
	// DurationMin 超阈持续分钟数。
	DurationMin int `json:"durationMin"`
	// SlopeMH 水位变化速率（m/h）。
	SlopeMH float64 `json:"slopeMH"`
	// Reason 研判原因。
	Reason string `json:"reason"`
	// Assignee 当前处置人。
	Assignee string `json:"assignee"`
	// Disposition 处置状态。
	Disposition string `json:"disposition"`
	// AckedAt / ClearedAt 确认与解除时刻。
	AckedAt   *int64 `json:"ackedAt"`
	ClearedAt *int64 `json:"clearedAt"`
}

// aiwaterWarningStatus 把 v3 的四态映射成对外状态词。
//
// 四态压成三态：CLEARED_UNACK 与 CLEARED_ACK 对外都是「已解除」，
// 区别是我们内部还要记「解除后有没有人确认过」，那是我们的处置流程细节。
func aiwaterWarningStatus(state string) string {
	switch state {
	case domain.StateActiveUnack:
		return "active"
	case domain.StateActiveAck:
		return "acknowledged"
	case domain.StateClearedUnack, domain.StateClearedAck:
		return "cleared"
	}
	return ""
}

// aiwaterWarningRecords 处理 A-3「预警记录分页查询」。
//
// 上限说明：一次最多取 1000 条再在内存里过滤分页。
// 预警表常规量级为几十到几百条，这个上限足够；
// 真到十万级需要给 store 加带条件的 count 与 limit，那是另一件事。
func (s *Server) aiwaterWarningRecords(w http.ResponseWriter, r *http.Request) {
	var q aiwaterWarningQuery
	if !decodeJSON(w, r, &q) {
		return
	}
	paging := pagingFrom(q.aiwaterPagingBody, r)

	evs, err := s.svc.ListAlerts(false, 1000)
	if err != nil {
		aiwaterError(w, err)
		return
	}

	rows := []aiwaterAlertRecord{}
	for _, ev := range evs {
		if pc := strings.TrimSpace(q.PointCode); pc != "" && ev.SiteID != pc {
			continue
		}
		if rc := strings.TrimSpace(q.RegionIndexCode); rc != "" {
			meta, ok := s.svc.Site(ev.SiteID)
			if !ok || meta.District != rc {
				continue
			}
		}
		if !aiwaterMatchLevel(q.Level, ev.Level) {
			continue
		}
		if st := strings.TrimSpace(q.Status); st != "" && aiwaterWarningStatus(ev.State) != st {
			continue
		}
		if q.BeginTime > 0 && ev.RaisedAt < q.BeginTime {
			continue
		}
		if q.EndTime > 0 && ev.RaisedAt > q.EndTime {
			continue
		}
		threshold := 0.0
		if meta, ok := s.svc.Site(ev.SiteID); ok {
			if th, found := aiwaterThresholdOf(meta, ev.Level); found {
				threshold = th
			}
		}
		district := ""
		if meta, ok := s.svc.Site(ev.SiteID); ok {
			district = meta.District
		}
		rows = append(rows, aiwaterAlertRecord{
			WarningID:    strconv.FormatInt(ev.ID, 10),
			PointCode:    ev.SiteID,
			Level:        aiwaterRiskOf(ev.Level),
			TriggerValue: ev.PeakValue,
			Threshold:    threshold,
			RainScene:    "unspecified",
			TriggerTime:  ev.RaisedAt,
			Status:       aiwaterWarningStatus(ev.State),
			EventID:      "warn-" + strconv.FormatInt(ev.ID, 10),
			WarnLevel:    ev.Level,
			State:        ev.State,
			SiteName:     ev.SiteName,
			District:     district,
			Score:        ev.Score,
			DurationMin:  ev.DurationMin,
			SlopeMH:      ev.SlopeMH,
			Reason:       ev.Reason,
			Assignee:     ev.Assignee,
			Disposition:  ev.Disposition,
			AckedAt:      ev.AckedAt,
			ClearedAt:    ev.ClearedAt,
		})
	}
	// 按触发时间倒序：值班员关心的是最近的。
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].TriggerTime > rows[j].TriggerTime })

	total := len(rows)
	page := sliceAIWater(rows, paging)
	if page == nil {
		page = []aiwaterAlertRecord{}
	}
	aiwaterOK(w, aiwaterListData[aiwaterAlertRecord]{
		aiwaterPage:     aiwaterPage[aiwaterAlertRecord]{Total: total, PageNo: paging.PageNo, PageSize: paging.PageSize, List: page},
		aiwaterTimeMeta: s.timeMetaOf(),
	})
}

// ---------------------------------------------------------------- A-4 雨情规则

// aiwaterRainRule 是 A-4 的一行。
type aiwaterRainRule struct {
	// RuleID 规则标识。
	RuleID string `json:"ruleId"`
	// PointCode 点位编码。
	PointCode string `json:"pointCode"`
	// MonitorItemCode 监测项编码（水位）。
	MonitorItemCode string `json:"monitorItemCode"`
	// RainScene 雨情场景（v3 无此模型，固定 unspecified）。
	RainScene string `json:"rainScene"`
	// ThresholdUpper 该等级的阈值上界（绝对高程 m）。
	ThresholdUpper float64 `json:"thresholdUpper"`
	// ThresholdLower 该等级的阈值下界（绝对高程 m）。
	ThresholdLower float64 `json:"thresholdLower"`
	// Level 等级：blue / yellow / orange / red。
	Level string `json:"level"`
	// Enabled 是否启用。
	Enabled bool `json:"enabled"`
	// EffectTime 生效时刻（仿真时钟秒）。
	EffectTime int64 `json:"effectTime"`
	// Version 规则版本。
	Version string `json:"version"`

	// ---- 扩展字段 ----
	// SiteName 站点名。
	SiteName string `json:"siteName"`
	// District 所属区域。
	District string `json:"district"`
	// DeviceType 设备类型（水位计）。
	DeviceType string `json:"deviceType"`
}

// aiwaterRainRuleResult 是 A-4 的响应体。
type aiwaterRainRuleResult struct {
	List []aiwaterRainRule `json:"list"`
	aiwaterTimeMeta
	// Version 规则版本（整批共用）。
	Version string `json:"version"`
	// Total 规则条数。
	Total int `json:"total"`
}

// aiwaterRainRuleQuery 是 A-4 的入参。
type aiwaterRainRuleQuery struct {
	// PointCode 点位过滤。
	PointCode string `json:"pointCode"`
	// DeviceType 设备类型过滤（当前只支持水位计）。
	DeviceType string `json:"deviceType"`
	// MonitorItemCode 监测项过滤。
	MonitorItemCode string `json:"monitorItemCode"`
	// RainScene 雨情场景过滤（v3 无此模型，传了也匹配不到）。
	RainScene string `json:"rainScene"`
}

// aiwaterRainRules 处理 A-4「雨情场景与阈值规则配置查询」（只读）。
//
// 阈值本身来自 v3 站点配置（service.Sites），规则版本来自引擎的 /rules。
// 引擎不可达时返回 503 而不是降级——对方的约定里 503 会退避重试，
// 给一份缺版本号的规则反而会让对方按错版本记账。
func (s *Server) aiwaterRainRules(w http.ResponseWriter, r *http.Request) {
	var q aiwaterRainRuleQuery
	if !decodeJSON(w, r, &q) {
		return
	}

	rules, ok := s.aiwaterEngineJSON(w, r, "/rules")
	if !ok {
		return // aiwaterEngineJSON 已经写过错误响应
	}
	version, _ := rules["version"].(string)

	fc := s.svc.Forecast()
	effectTime := int64(0)
	if fc != nil {
		effectTime = fc.IssuedAt
	}

	// 阈值上界的物理天花板：引擎把水位裁剪到 base+1.5（真实内涝的街道调蓄上限），
	// 红色档没有更高的阈值，就以这个物理上限收口。
	const levelCap = 1.5

	list := []aiwaterRainRule{}
	for _, meta := range s.svc.Sites() {
		if pc := strings.TrimSpace(q.PointCode); pc != "" && meta.SiteID != pc {
			continue
		}
		if dt := strings.TrimSpace(q.DeviceType); dt != "" && dt != "water_level" {
			continue
		}
		if mi := strings.TrimSpace(q.MonitorItemCode); mi != "" && mi != "water_level" {
			continue
		}
		levels := []string{"blue", "yellow", "orange", "red"}
		for i, lv := range levels {
			if i >= len(meta.Thresholds) {
				break
			}
			lower := meta.BaseLevel
			if i > 0 {
				lower = meta.BaseLevel + meta.Thresholds[i-1]
			}
			upper := meta.BaseLevel + meta.Thresholds[i]
			if i == len(levels)-1 {
				upper = meta.BaseLevel + levelCap
			}
			list = append(list, aiwaterRainRule{
				RuleID:          "rr-" + meta.SiteID + "-" + lv,
				PointCode:       meta.SiteID,
				MonitorItemCode: "water_level",
				RainScene:       "unspecified",
				ThresholdUpper:  upper,
				ThresholdLower:  lower,
				Level:           lv,
				Enabled:         true,
				EffectTime:      effectTime,
				Version:         version,
				SiteName:        meta.Name,
				District:        meta.District,
				DeviceType:      "water_level",
			})
		}
	}

	aiwaterOK(w, aiwaterRainRuleResult{
		List:            list,
		aiwaterTimeMeta: s.timeMetaOf(),
		Version:         version,
		Total:           len(list),
	})
}

// aiwaterEngineJSON 调引擎的 GET 接口并把结果解成 map。
//
// 引擎不可达时写 503 并返回 false——调用方直接 return，不用再处理错误。
//
// 用的是「解成 map」而不是透传原响应：网关的出参要按对方口径重新拼，
// 直接透传会把引擎的 snake_case 泄漏出去。
func (s *Server) aiwaterEngineJSON(w http.ResponseWriter, r *http.Request, path string) (map[string]any, bool) {
	res, err := s.eng.Get(path, r.URL.RawQuery)
	if err != nil {
		aiwaterFail(w, http.StatusServiceUnavailable, aiwaterCodeUnavailable,
			"引擎不可达: "+err.Error())
		return nil, false
	}
	defer res.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		aiwaterFail(w, http.StatusServiceUnavailable, aiwaterCodeUnavailable,
			"引擎响应读取失败: "+err.Error())
		return nil, false
	}
	if res.Status >= 400 {
		aiwaterFail(w, http.StatusServiceUnavailable, aiwaterCodeUnavailable,
			fmt.Sprintf("引擎返回 %d", res.Status))
		return nil, false
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		aiwaterFail(w, http.StatusServiceUnavailable, aiwaterCodeUnavailable,
			"引擎响应无法解析: "+err.Error())
		return nil, false
	}
	return out, true
}

// ---------------------------------------------------------------- A-5 模型版本

// aiwaterModelQuery 是 A-5 的入参。
type aiwaterModelQuery struct {
	// Action list（默认）或 switch。
	Action string `json:"action"`
	// TaskType 任务类型过滤（当前只有水位预测一种）。
	TaskType string `json:"taskType"`
	// VersionID 切换目标版本（action=switch 时必填）。
	VersionID string `json:"versionId"`
	// RequestId 切换请求的幂等键。
	RequestId string `json:"requestId"`
	// Confirm 二次确认位。切换模型是高影响写操作，没有它一律拒绝。
	Confirm bool `json:"confirm"`
}

// aiwaterModelVersion 是 A-5 的一行。
type aiwaterModelVersion struct {
	// VersionID 版本标识。
	VersionID string `json:"versionId"`
	// VersionName 版本显示名。
	VersionName string `json:"versionName"`
	// TaskType 任务类型。
	TaskType string `json:"taskType"`
	// DeployTime 部署时刻（Unix 秒）。
	DeployTime int64 `json:"deployTime"`
	// Status 状态：active（生效中）/ idle（待命）。
	Status string `json:"status"`

	// ---- 扩展字段 ----
	// Active 是否为当前生效版本。
	Active bool `json:"active"`
	// RMSE3H 3h 预见期的均方根误差（m）。
	RMSE3H *float64 `json:"rmse3h"`
	// Skill3H 3h 预见期的技巧评分。
	Skill3H *float64 `json:"skill3h"`
	// Folds 交叉验证折数。
	Folds int `json:"folds"`
	// TrainSeconds 训练耗时（秒）。
	TrainSeconds float64 `json:"trainSeconds"`
	// SizeMB 模型文件大小（MB）。
	SizeMB float64 `json:"sizeMb"`
}

// aiwaterModelResult 是 A-5 的响应体。
type aiwaterModelResult struct {
	List []aiwaterModelVersion `json:"list"`
	aiwaterTimeMeta
	// ActiveVersion 当前生效版本。
	ActiveVersion string `json:"activeVersion"`
	// Total 版本条数。
	Total int `json:"total"`
	// EffectiveTime 切换生效时刻（action=switch 时有值）。
	EffectiveTime int64 `json:"effectiveTime"`
}

// aiwaterModelVersions 处理 A-5「模型版本列表与切换」。
//
// action=list：只读，透传引擎的 /models/versions 并换字段名。
// action=switch：写操作。要求请求体带 confirm=true 作二次确认，
// 并落到既有审计中间件（Audit 对所有 /api/ 下的 POST 生效）。
func (s *Server) aiwaterModelVersions(w http.ResponseWriter, r *http.Request) {
	var q aiwaterModelQuery
	if !decodeJSON(w, r, &q) {
		return
	}
	action := strings.ToLower(strings.TrimSpace(q.Action))
	if action == "" {
		action = "list"
	}

	switch action {
	case "list":
		s.aiwaterModelList(w, r, q)
	case "switch":
		s.aiwaterModelSwitch(w, r, q)
	default:
		aiwaterFail(w, http.StatusBadRequest, aiwaterCodeBadRequest,
			"action 只能是 list 或 switch，当前: "+action)
	}
}

// aiwaterModelList 返回模型版本清单。
func (s *Server) aiwaterModelList(w http.ResponseWriter, r *http.Request, q aiwaterModelQuery) {
	body, ok := s.aiwaterEngineJSON(w, r, "/models/versions")
	if !ok {
		return
	}
	active, _ := body["active"].(string)
	rawList, _ := body["versions"].([]any)

	list := []aiwaterModelVersion{}
	for _, it := range rawList {
		m, isMap := it.(map[string]any)
		if !isMap {
			continue
		}
		version, _ := m["version"].(string)
		if version == "" {
			continue
		}
		if tt := strings.TrimSpace(q.TaskType); tt != "" && tt != "water_level_forecast" {
			continue
		}
		trainedAt := int64(0)
		switch v := m["trained_at"].(type) {
		case float64:
			trainedAt = int64(v)
		case int64:
			trainedAt = v
		}
		isActive := version == active
		status := "idle"
		if isActive {
			status = "active"
		}
		list = append(list, aiwaterModelVersion{
			VersionID:    version,
			VersionName:  version,
			TaskType:     "water_level_forecast",
			DeployTime:   trainedAt,
			Status:       status,
			Active:       isActive,
			RMSE3H:       aiwaterFloatPtr(m["rmse_3h"]),
			Skill3H:      aiwaterFloatPtr(m["skill_3h"]),
			Folds:        aiwaterIntOf(m["folds"]),
			TrainSeconds: aiwaterFloatOf(m["train_seconds"]),
			SizeMB:       aiwaterFloatOf(m["size_mb"]),
		})
	}

	aiwaterOK(w, aiwaterModelResult{
		List:            list,
		aiwaterTimeMeta: s.timeMetaOf(),
		ActiveVersion:   active,
		Total:           len(list),
	})
}

// aiwaterModelSwitch 切换生效模型版本。
func (s *Server) aiwaterModelSwitch(w http.ResponseWriter, r *http.Request, q aiwaterModelQuery) {
	version := strings.TrimSpace(q.VersionID)
	if version == "" {
		aiwaterFail(w, http.StatusBadRequest, aiwaterCodeBadRequest, "切换模型必须提供 versionId")
		return
	}
	if !q.Confirm {
		// 二次确认不是形式：切换模型会让所有站点的预测曲线与告警等级当场改变，
		// 而对方 SDK 的重试逻辑会重复发同一个请求。没有 confirm 就切换，
		// 等于让一次网络抖动变成一次静默的线上变更。
		aiwaterFail(w, http.StatusBadRequest, aiwaterCodeBadRequest,
			"切换模型版本属于高影响写操作，请在请求体中带 confirm=true 完成二次确认")
		return
	}

	res, err := s.eng.PostEmpty("/models/adopt", "version="+url.QueryEscape(version))
	if err != nil {
		aiwaterFail(w, http.StatusServiceUnavailable, aiwaterCodeUnavailable,
			"引擎不可达: "+err.Error())
		return
	}
	defer res.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.Status >= 400 {
		aiwaterFail(w, http.StatusBadRequest, aiwaterCodeBadRequest,
			fmt.Sprintf("引擎拒绝切换版本 %s（HTTP %d）", version, res.Status))
		return
	}
	var out map[string]any
	_ = json.Unmarshal(raw, &out)

	// 模型换了，预测曲线与告警等级全变，让所有前端重拉。
	s.svc.Hub().Broadcast("forecast", map[string]any{"action": "model_adopted", "version": version})

	aiwaterOK(w, aiwaterModelResult{
		List:            []aiwaterModelVersion{},
		aiwaterTimeMeta: s.timeMetaOf(),
		ActiveVersion:   version,
		Total:           0,
		EffectiveTime:   nowWall(),
	})
}

// aiwaterFloatPtr 从 map 里取浮点数；不存在或类型不对时返回 nil。
//
// 用指针而不是 0 值：0 和「没有这个指标」在语义上完全不同，
// rmse_3h=0 说明模型完美，而实际是「还没训练出来」。
func aiwaterFloatPtr(v any) *float64 {
	f, ok := v.(float64)
	if !ok {
		return nil
	}
	return &f
}

func aiwaterFloatOf(v any) float64 {
	f, _ := v.(float64)
	return f
}

func aiwaterIntOf(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	}
	return 0
}
