package icm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
)

// ---------------------------------------------------------------- 补充复用接口
//
// 【事实】设计文档 §3.4：基础文档表一偏重「取数 + 视频」，以下 ICM 既有接口
// 覆盖 23 条功能条款中「复用既有模块」的要求，仍按对方原样调用。
//
// 【纪律】对方文档只给出了这些接口的**关键字段**，未给出完整请求/响应结构，
// 因此这里不编造 struct，只登记真实路径 + 提供通用调用入口；
// 请求体由调用方按对方原件以 map[string]any 填写，响应原样返回 RawMessage。
// 待联调拿到真实报文后，再按 endpoints.go 的方式收敛成强类型。

const (
	// GET + Query（与「全部 POST+JSON」的通用约定不同，属对方既有事实，按原件）
	PathSensorThreshold = "/api/pems/v1/public/sensor/threshold"
	PathThresholdList   = "/api/pems/v1/public/monitor/getThresholdList"

	// POST + JSON
	PathDictFirstLayer    = "/api/common/v1/dictionary/getFirstLayerByTypeCode"
	PathDictByValue       = "/api/common/v1/dictionary/getByTypeCodeAndDataValue"
	PathAlarmTypes        = "/api/cisrm/v1/device/alarmTypes"
	PathDeviceTypes       = "/api/cisrm/v1/device/types"
	PathAlarmConfig       = "/api/cisrm/v1/device/queryAlarmConfig"
	PathDeviceOnlineStats = "/api/cisrm/v1/device/deviceOnlineStatistics"
	PathFacilityAlarm     = "/api/cisrm/v1/facilities/findAlarmByParams"
	PathFacilityData      = "/api/cisrm/v1/facilities/data"
	PathFacilityTypes     = "/api/cisrm/v1/facilities/types"
	PathRecordList        = "/api/nms/v1/record/list"
	PathRiskAlarmIssue    = "/api/v1/drrm/riskAlarm/issue"
	PathRiskAlarmPage     = "/api/v1/drrm/riskAlarm/findPage"
	PathCaseQuery         = "/api/v1/application/citycasehandle/service/rs/case/v1/query"
)

// SupplementalPaths 是补充复用接口的编号 → 真实地址登记表，便于 grep 与联调核对。
// 与 endpoints.go 的 12 条表一接口合起来 = 设计文档 §3 的完整复用清单。
var SupplementalPaths = map[string]string{
	"R13": PathDictFirstLayer,
	"R14": PathDictByValue,
	"R15": PathSubscriptionView,
	"R16": PathAlarmTypes,
	"R17": PathDeviceTypes,
	"R18": PathAlarmConfig,
	"R19": PathSensorThreshold,
	"R20": PathThresholdList,
	"R21": PathFacilityAlarm,
	"R22": PathDeviceOnlineStats,
	"R23": PathRecordList,
	"R24": PathRiskAlarmIssue,
	"R25": PathFacilityData,
	"R26": PathCaseQuery,
}

// CallJSON 以 POST + JSON 调用补充接口，返回原始 data。
// body 按对方原件字段名填写；不做字段改写，避免"简化命名"污染复用口径。
func (c *Client) CallJSON(ctx context.Context, path string, body any) (json.RawMessage, error) {
	return c.DoRaw(ctx, http.MethodPost, path, body)
}

// CallQuery 以 GET + Query 调用补充接口（R19/R20 属此类）。
func (c *Client) CallQuery(ctx context.Context, path string, query url.Values) (json.RawMessage, error) {
	return c.DoRaw(ctx, http.MethodGet, path, query)
}

// QueryDictionary 数据字典首层（R13）。
// 入 typeCode(必填)、language；出 data[]{typeCode,dataKey,dataValue,name,expand}。
// typeCode 明细未提供（§8 Q4），由调用方从对方《对外数据字典项.xlsx》取得后传入。
func (c *Client) QueryDictionary(ctx context.Context, typeCode, language string) (json.RawMessage, error) {
	return c.CallJSON(ctx, PathDictFirstLayer, map[string]any{
		"typeCode": typeCode,
		"language": language,
	})
}

// QuerySensorThreshold 环境量多级阈值（R19，GET + Query）。
// 入 orgIndexCode(必填)、sensorName、sensorTypes、pageNo/pageSize；
// 出 thresholdList[]{eventType,eventCode,lowValue,highValue,order,sort}。
func (c *Client) QuerySensorThreshold(ctx context.Context, orgIndexCode string, extra url.Values) (json.RawMessage, error) {
	q := url.Values{}
	q.Set("orgIndexCode", orgIndexCode)
	for k, vs := range extra {
		for _, v := range vs {
			q.Add(k, v)
		}
	}
	return c.CallQuery(ctx, PathSensorThreshold, q)
}

// EXT-POINT(INTEGRATION): R24 风险告警上报 / R26 工单联动属**写接口**，
// 需先申请事件类型号段与写权限（§8 Q3/Q5）。默认不启用：CallJSON 只是通用
// 通道，是否调用由上层 feature flag 决定，本包不主动发起任何写操作。
// 接口签名：CallJSON(ctx, PathRiskAlarmIssue, body) (json.RawMessage, error)
// 契约返回：对方 {code:"0",msg,data} 包中的 data（写操作结果），失败返回 *APIError。
