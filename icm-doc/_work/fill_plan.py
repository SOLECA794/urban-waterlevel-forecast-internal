# -*- coding: utf-8 -*-
"""把基础版三个 sheet 的待补充内容写进去。不新增 sheet。"""
import math, os, shutil
import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
from copy import copy

SRC = r'C:\Users\34511\xwechat_files\wxid_7s246xdls0k022_0127\msg\file\2026-11\水涝监测软件部分接口技术方案.xlsx'
OUT = r'D:\Desktop\waterLevelForcasting\waterlog-v3\docs\水涝监测软件部分接口技术方案-补全版.xlsx'

# ---------------------------------------------------------------- 表一 12 条修正
T1 = {}   # 行号 -> (E, F, 备注追加)
T1[3] = (
 'deviceType（设备类型，必填）、indexCodes[]（设备编码集合）、beginTime/endTime（监测时间范围，ISO8601带时区）、isDesc（是否按监测时间降序）、pageNo（必填）、pageSize（必填）',
 'code、msg、data.total、data.pageNo、data.pageSize、data.list[].id、indexCode（设备编码）、wl（监测数据）、monitorTime（监测时间）、createTime（入库时间）',
 '监测点位实时值核心数据源。原件中 data.list[].wl 为字段名占位——实际字段名随设备监测项编码变化（如水位监测项为 wl），须先经表一第 13 条取 monitorItemCode 解析；本接口 wl 为 String 型，与第 2 条历史接口的 Number 型不一致，实现须做类型归一化。批量 indexCodes 单次≤100，避免全量拉取。')
T1[4] = (
 'deviceType（必填）、indexCodes[]、beginTime/endTime（ISO8601带时区）、isDesc、pageNo、pageSize',
 'code、msg、data.total、data.pageNo、data.pageSize、data.list[].id、indexCode、wl（Number 型）、monitorTime、createTime',
 '用于历史样本与实测对照；单次查询时间跨度建议≤7天，pageSize≤1000。原件 wl 为 Number 型，与第 1 条实时接口的 String 型不一致，实现须做类型归一化。')
T1[5] = (
 'menuCode（业务应用编码）、deviceTypes[]（设备类型集合）、deviceIds[]（设备编码集合）、deviceName（支持模糊）、regionCode（区域编码）、includeSubRegion（是否含下级区域）、onlineStatus（在线状态）、pageNo（必填）、pageSize（必填）',
 'code、msg、data.total、data.list[].id、indexCode、menuCode、deviceName、deviceType、deviceTypeName、regionCode、regionName、regionPath、regionPathName、address、domainId、longitude、latitude、onlineStatus、isVss、picUrls[]',
 '点位经纬度、安装位置用于风险点位与地图关联展示。原件入参无 regionIndexCode 字段，区域过滤须传 regionCode。')
T1[6] = (
 'menuCode、deviceTypes[]、deviceIds[]、deviceName、regionCode、includeSubRegion、onlineStatus、pageNo（必填）、pageSize（必填）',
 'code、msg、data.list[].id、indexCode、menuCode、deviceName、deviceType、deviceTypeName、regionCode、regionName、regionPath、regionPathName、longitude、latitude、address、onlineStatus、runningStatus[]（运行状态集合）',
 '离线/数据缺失时预测任务标注「输入数据缺失」状态。原件本接口入参同第 3 条，而出参中的运行状态为 runningStatus 数组；电池电量、电压、信号强度等明细不在本接口，须经动环监控接口获取。')
T1[7] = (
 'pageNo（必填）、pageSize（必填）、treeCode（区域树编码，不传默认 "0" 国标树）',
 'code、msg、data.total、data.pageNo、data.pageSize、data.list[].indexCode（区域编号）、name（区域名称）、parentIndexCode、treeCode、externalIndexCode',
 '区域树为预警规则、统计分析与权限数据域的划分依据。原件本接口入参只有 pageNo/pageSize/treeCode，不含 parentIndexCode 与 regionType；按下级区域须调第 6 条。')
T1[8] = (
 'parentIndexCode（上级区域编号，必填）、treeCode（区域树编码）',
 'code、msg、data.total、data.list[].indexCode、name、parentIndexCode、treeCode、externalIndexCode',
 '按层级懒加载，减少全量区域传输开销。原件本接口无分页入参（一次返回全部下级），亦无 pageNo/pageSize。')
T1[9] = (
 'pageNo（必填）、pageSize（必填）、treeCode（区域树编码）',
 'code、msg、data.total、data.list[].cameraIndexCode（监控点编号）、gbIndexCode、name、deviceIndexCode、longitude、latitude、altitude、pixel、cameraType、cameraTypeName、installPlace、viewshed、capabilitySet、capabilitySetName、intelligentSet[]',
 '监控点与易涝点、监测设备做空间关联。原件本接口入参无 regionIndexCode，区域归属以返回的 deviceIndexCode 或资源树映射确定；字段名为 name（非 cameraName）。')
T1[10] = (
 'pageNo（必填）、pageSize（必填）、geometryType（几何类型：Circle/Polygon，必填）、treeCode、longitude（经度，Circle 时必填）、latitude（纬度，Circle 时必填）、distance（半径，米，Circle 时必填）、wkt（多边形坐标串，Polygon 时必填）',
 'code、msg、data.total、data.list[].cameraIndexCode、name、longitude、latitude、deviceIndexCode、capabilitySet',
 '用于「点位—周边视频」空间检索，支撑积水识别取流。原件入参为 geometryType +（longitude/latitude/distance 或 wkt），不是简单的 spatialIndex。')
T1[11] = (
 'cameraIndexCode（监控点编号，必填）、streamType（码流类型：0 主/1 子）、protocol（取流协议）、transmode（传输模式）、expand',
 'code、msg、data.url（取流地址）',
 '取流 URL 具时效性，禁止落库长期缓存；须在有效期内使用，过期或失效时重新获取。原件响应体中无 expireTime 字段，有效期以平台实际说明为准。')
T1[12] = (
 'cameraIndexCode（必填）、beginTime（必填）、endTime（必填）、recordLocation（录像存储位置）、protocol、needReturnClipInfo（是否返回录像片段信息）、uuid、expand',
 'code、msg、data.url、data.uuid、data.list[].beginTime、endTime、size',
 '用于积水事件复核与训练样本回溯，单段录像建议≤1小时。原件响应体无 expireTime；带 needReturnClipInfo=true 时返回片段清单。')
T1[13] = (
 'pageNo（必填）、pageSize（必填）、indexCodes[]（监控点编号集合，必填）',
 'code、msg、data.list[].indexCode、inspectDate、inspectResult、picUrl、resolution、scBlurResult、scLumaResult、scChromaResult、scContrastResult、scDarkResult、scShakeResult、scStreakResult、scFreezeResult、scSnowResult、scCoverResult、scSignalResult、scMonoResult',
 '视频质量异常点位置信度降权，避免脏数据影响积水识别。原件本接口入参只有 indexCodes，无时间范围，故只能取最近一次巡检结果，按巡检日组织查询。')
T1[14] = (
 'eventTypes[]（事件类型号段集合，必填）、subWay（订阅方式：1 事件回调/2 MQTT）、eventDest（事件回调地址）、subType（订阅类型）、eventLvl[]（事件等级）',
 'code、msg、data.host、data.userName、data.password、data.list[].clientId、topicName、eventType',
 '事件类型号段须向平台统一申请（见接口集成约定第 9 条）；回调接口须实现验签与幂等去重。原件中回调地址字段名为 eventDest（不是 callbackUrl），且响应体返回的是 MQTT 连接信息（host/userName/password/topicName），不含 subscribeId；订阅状态须经第 28 条查询。')

# 表一新增行： (名称, 地址, E, F, 频率, 超时, 重试, 条款, 备注, 方法)
NEW1 = [
 ('获取设备类型及监测项字典', '/api/cisrm/v1/device/types',
  '无入参',
  'code、msg、data[].deviceType（设备类型编码）、name、menuCode、menuName、iconUrl、monitorItems[].monitorItemId、monitorItemCode（监测项标识）、monitorItemType、monitorItemName、dataType、unit、values[].value、name',
  '启动加载 1 次 + 每日 1 次全量同步', '5s',
  '幂等读接口，重试 2 次，间隔 1s、3s；失败沿用本地字典',
  '监测信息管理（设备类型与监测项）；预警功能配置-2 预警阈值分级配置',
  '第 1、2 条监测数据接口中 wl 等动态字段名的权威来源；示例：水位观测球 deviceType="waterLevelGauge"，监测项 monitorItemCode="wl"（单位 m）。未先取本字典无法正确解析监测值。', 'POST + application/json'),
 ('获取报警类型字典', '/api/cisrm/v1/device/alarmTypes',
  '无入参',
  'code、msg、data[].alarmType（报警类型编码）、alarmCode、alarmName、menuCode',
  '每日 1 次全量同步', '5s',
  '幂等读接口，重试 2 次，间隔 1s、3s',
  '监测信息管理（报警类型管理）；预警功能配置-2 预警阈值分级配置',
  '报警类型编码的权威来源，避免在各系统内硬编码；示例 alarmType="waterLevelHighAlarm"（水位超限报警）。', 'POST + application/json'),
 ('根据设备ID获取设备报警配置', '/api/cisrm/v1/device/queryAlarmConfig',
  'deviceId（设备唯一标识，必填）',
  'code、msg、data.monitorItemId、monitorItemCode、monitorItemName、alarmType、alarmCode、alarmName、symbol（比较符）、value（报警值）、unit',
  '配置变更后按需查询；每日校核 1 次', '5s',
  '幂等读接口，重试 2 次，间隔 1s、3s',
  '预警功能配置-2 预警阈值分级配置；监测设备接入管控',
  '设备侧既有报警条件，可作为阈值基线比对，避免设备侧与本平台侧双份口径不一致。', 'POST + application/json'),
 ('统计设备在线情况', '/api/cisrm/v1/device/deviceOnlineStatistics',
  '无入参',
  'code、msg、data[].deviceType、name（设备类型名称）、totalQuantity（总数）、onlineQuantity（在线数）、offlineQuantity（离线数）',
  '运维看板 5min/次', '5s',
  '幂等读接口，重试 2 次，间隔 1s、3s',
  '物联设备运维管理-1 设备状态统计',
  '平台侧已聚合的在线率数据，用于看板统计，避免逐台设备统计造成的取数开销。', 'POST + application/json'),
 ('分页查询环境量阈值配置', '/api/pems/v1/public/sensor/threshold',
  'sensorName（传感器名称）、transducerName（变送器名称）、sensorIndexCode（环境量编号）（三者均可选，Query 传参）',
  'code、msg、data.total、data.pageNo、data.pageSize、data.totalPage、data.list[].indexCode、sensorType、sensorTypeName、sensorName、transducerName、deviceName、allowLow、allowHigh、unit、latestValue、latestTime、thresholdList[].eventType、eventName、eventCode、order、sort、lowValue、highValue、lowOperator、highOperator、stateName、isPushEsc',
  '启动加载 1 次 + 阈值配置变更后刷新', '8s',
  '幂等读接口，重试 2 次，间隔 2s、5s；失败沿用本地缓存',
  '预警功能配置-2 预警阈值分级配置；雨水管网、污水管网、易涝点监测',
  '动环侧阈值主数据。thresholdList 中的 lowValue/highValue 为设备报警条件；本平台按雨情场景细分的分级阈值仍由本平台规则表维护，两套阈值须建立映射关系，以本平台规则为预警触发口径。', 'GET + Query 参数'),
 ('获取环境量事件类型', '/api/pems/v1/public/monitor/getThresholdList',
  'sensorType（环境量类型，必填，Query 传参）',
  'code、msg、data[].eventType（事件类型）、eventName、eventCode',
  '字典变更时同步', '5s',
  '幂等读接口，重试 2 次，间隔 1s、3s',
  '预警功能配置-2 预警阈值分级配置；接口集成约定第 8 条 数据字典统一管理',
  '与阈值配置中的 thresholdList[].eventType 对应，用于事件类型编码归一。', 'GET + Query 参数'),
 ('获取环境量类型', '/api/pems/v1/public/monitor/sensor/types',
  '无入参',
  'code、msg、data[].key（类型编码）、name（类型名称）、defaultUnit（默认单位）、subType（子类型）',
  '启动加载 1 次 + 每日 1 次同步', '5s',
  '幂等读接口，重试 2 次，间隔 1s、3s',
  'AI平台-1 多源异构数据融合；预警功能配置-2 预警阈值分级配置',
  '环境量类型字典，供阈值配置、历史数据接口的 sensorType/indexCode 取参使用。', 'GET + Query 参数'),
 ('获取当日环境量最新实时数据', '/api/pems/v1/public/monitor/history/latestValue',
  'userId（用户编号，请求头 Head，可选）；indexCodes（环境量编号，多个以逗号分隔，必填，Query 传参）',
  'code、msg、data.realTimeValue（实时值）、data.updateTime（更新时间）',
  '实时展示 30s/次；预警判定 1min/次', '5s',
  '幂等读接口，重试 2 次，间隔 1s、3s',
  '预警功能配置-4 监测数据规则判定；AI平台-4 多时间尺度水位趋势预测',
  '轻量取最新值的补充通道：当第 1 条分页接口开销偏大时，用于看板高频刷新；仅返回当日最新值，不做历史回溯。', 'GET + Query 参数'),
 ('查询环境量历史数据（近几日）', '/api/pems/v3/public/sensor/history-data',
  'indexCode（环境量编号，必填）、from（开始时间）、to（结束时间）、subDay（指定日期：0 今日/-1 昨日/-2 前日/3 三天）、sortOrder（排序方式）；subDay 与 from、to 不可同时传',
  'code、msg、data.id、data.items[].time（毫秒时间戳）、XField/YField（曲线点）、data.limits[].name、type、value',
  '趋势分析 10min/次；数据补齐按需', '10s',
  '幂等读接口，重试 2 次，间隔 2s、5s',
  'AI平台-1 多源异构数据融合；AI平台-4 多时间尺度水位趋势预测',
  '仅支持有限回溯窗口（当日/前两日/近三日），长周期历史仍以第 2 条设备历史数据接口为准。', 'GET + Query 参数'),
 ('批量获取环境量统计数据', '/api/pems/v1/public/monitor/history/statistics/batch',
  'userId（请求头 Head，可选）；indexCodes（环境量编号，多个以逗号分隔）、grain（统计粒度：0 小时/1 天/2 周/3 月/4 年）、from、to（Query 传参）',
  'code、msg、data[].indexCode、data[].historyDataChartVO.id、items[].time、max、min、XField、YField、limits[].name、type、value',
  '统计看板 30min/次', '15s',
  '幂等读接口，重试 2 次，间隔 3s、6s；indexCodes 批量≤50',
  'AI平台-1 多源异构数据融合；AI平台-7 预测结果展示与历史分析',
  '平台侧已聚合的极值统计，可显著减少原始数据拉取量；统计粒度按展示周期选择，避免超大数据量返回。', 'GET + Query 参数'),
 ('获取所有设施类型', '/api/cisrm/v1/facilities/types',
  '无入参',
  'code、msg、data[].resourceType（设施类型编码）、resourceTypeName、menuCode、menuName、iconUrl',
  '启动加载 1 次 + 每日 1 次同步', '5s',
  '幂等读接口，重试 2 次，间隔 1s、3s',
  '雨水管网、污水管网、易涝点监测-1/2/3',
  '易涝点设施类型示例 resourceType="floodPoint"，雨水管网 "rainPipeNet"；设施类型是设施侧取数的必要入参。', 'POST + application/json'),
 ('根据设施ID获取设施最新监测数据', '/api/cisrm/v1/facilities/data',
  'id（设施唯一标识，必填）',
  'code、msg、data.deviceId、monitorItemId、monitorItemCode、monitorItemType、monitorItemName、monitorTime、value、unit',
  '设施详情页按需调用', '5s',
  '幂等读接口，重试 2 次，间隔 1s、3s',
  '雨水管网、污水管网、易涝点监测-1/2/3；监测信息管理',
  '以「设施」为主键取数，与以「设备」为主键取数形成互补，用于易涝点详情页一次取到当前值。', 'POST + application/json'),
 ('分页查询设施报警记录', '/api/cisrm/v1/facilities/findAlarmByParams',
  'menuCode、regionIndexCode、includeSubRegion、facilityName、facilityTypes[]、facilityIndexCodes[]、deviceType、deviceIndexCodes[]、alarmTypes[]、queryTimeType、beginTime、endTime（ISO8601带时区）、alarmStatus、auditStatus、auditResult、pageNo（必填）、pageSize（必填）',
  'code、msg、data.total、data.pageNo、data.pageSize、data.list[].alarmId、alarmType、alarmName、alarmTimeFirst、alarmTimeLast、alarmTimeEnd、alarmTimes、alarmThreshold、alarmCondition、alarmValue、alarmPicUrl、alarmStatus、auditStatus、auditResult、facilityIndexCode、facilityType、facilityTypeName、facilityName、regionIndexCode、regionName、address、deviceIndexCode、deviceType、deviceMonitorItemCode',
  '报警列表 1min/次；历史查询按需', '10s',
  '幂等读接口，重试 2 次，间隔 2s、5s；单次查询跨度建议≤7天',
  '预警功能配置-4 监测数据规则判定；预警功能配置-5 分级告警与信息关联',
  '含平台侧处置与审核状态（alarmStatus/auditStatus/auditResult），可用于与本平台预警记录对账，避免两侧口径分歧。示例 facilityTypes=["rainPipeNet"]、deviceType="waterQualityMonitor"。', 'POST + application/json'),
 ('分页查询数据字典（第一层）', '/api/common/v1/dictionary/getFirstLayerByTypeCode',
  'typeCode（字典类型，必填，长度 1-255 位）、language（多语言，可选：zh_CN/en_US）',
  'code、msg、data.typeCode、dataKey、dataValue、name、expand',
  '启动加载 1 次 + 字典版本变更后同步', '5s',
  '幂等读接口，重试 2 次，间隔 1s、3s；失败沿用本地字典',
  '接口集成约定第 8 条 数据字典统一管理；预警功能配置-2',
  '风险等级、雨情场景、事件状态等枚举均经本接口获取，禁止硬编码；新增字典项须先向基础平台申请 typeCode。', 'POST + application/json'),
 ('按字典类型与值查询字典项', '/api/common/v1/dictionary/getByTypeCodeAndDataValue',
  'typeCode（必填）、value（字典值，必填）、language（可选）',
  'code、msg、data.typeCode、dataKey、dataValue、name、expand',
  '值回显/反查时按需调用', '5s',
  '幂等读接口，重试 2 次，间隔 1s、3s',
  '接口集成约定第 8 条 数据字典统一管理',
  '用于将监测报文或报警记录中的编码回显为可读名称，与上一条配合完成字典双向查找。', 'POST + application/json'),
 ('查询事件订阅信息', '/api/eventService/v1/eventSubscriptionView',
  'subWay（订阅方式：1 事件回调/2 MQTT，不填默认 1）',
  'code、msg、data.detail（订阅详情）、data.eventTypes（已订阅事件类型）、data.eventDest（回调地址）',
  '平台启动时查询 1 次；断线重连后查询 1 次', '5s',
  '幂等读接口，重试 2 次，间隔 1s、3s',
  '内涝底座接口开放-4 事件订阅；预警功能配置-5 分级告警与信息关联',
  '第 12 条订阅接口超时或断线后的核对手段：先查询现有订阅状态，再决定是否重新订阅，避免重复订阅产生多路推送。', 'POST + application/json'),
 ('根据监控点列表查询录像完整性', '/api/nms/v1/record/list',
  'pageNo（必填）、pageSize（必填）、beginTime（必填）、endTime（必填）、indexCodes[]（监控点编号集合）、storageTypes[]（存储类型集合）',
  'code、msg、data.total、data.pageNo、data.pageSize、data.list[].indexCode、date、collectTime、inspectionDate、result（完整性结论）、videoClips、timeSegment、from、to、type、intactDuration、planDuration',
  '训练样本准备阶段按需调用；每日 1 次巡检', '15s',
  '幂等读接口，重试 2 次，间隔 3s、6s；indexCodes 批量≤50',
  '模型应用与调配-1 训练数据组织与管理',
  '在取回放流之前先确认录像完整性，避免取到残缺片段污染训练样本；intactDuration/planDuration 可用于样本质量打分。', 'POST + application/json'),
 ('风险类别分页查询', '/api/v1/drrm/riskType/findPage',
  'pageNo（必填，1~100000）、pageSize（必填，20~2000）、resourceType（设施类型，可选）',
  'code、msg、data.total、data.pageNo、data.pageSize、data.list[].id、riskTypeName（风险类别名称）、riskAnalysis（风险分析）、accidents（事故情形）、controlMeasures（管控措施）、resourceType',
  '启动加载 1 次 + 每日 1 次同步', '8s',
  '幂等读接口，重试 2 次，间隔 2s、5s',
  'AI平台-5 风险等级智能研判',
  '下发风险预警处置（第 32 条）时必须携带 riskTypeId，本接口是其取值来源。pageSize 下限为 20，不可传 1。', 'POST + application/json'),
 ('风险预警分页查询', '/api/v1/drrm/riskAlarm/findPage',
  'Token（认证信息，请求头 Head，必填）；pageNo（必填）、pageSize（必填）、resourceType、riskUnitName（风险单元名称，模糊）、regionCode、isSubRegion',
  'code、msg、data.total、data.list[].id、resourceRiskId、riskUnitName、resourceId、resourceType、resourceTypeName、riskLevelType、riskLevelTypeName、riskTypes、riskSourceType、riskSourceName、score（风险分）、address、alarmTime、indexInfos',
  '风险看板 5min/次', '10s',
  '幂等读接口，重试 2 次，间隔 2s、5s',
  'AI平台-5 风险等级智能研判',
  '平台风险清单侧已产生的风险预警，可与本平台研判结果互校；本接口需在请求头携带 Token，与约定第 1 条的令牌获取方式一并确认。', 'POST + application/json'),
 ('风险预警下发处置', '/api/v1/drrm/riskAlarm/issue',
  'Token（认证信息，请求头 Head，必填）；id（风险预警ID，必填）、riskTypeId（风险类别ID，必填）',
  'code、msg',
  '研判命中风险后按需调用', '10s',
  '写类接口，超时后禁止盲目重提，须先查询风险预警状态再决定；重试 2 次，间隔 3s、6s',
  'AI平台-5 风险等级智能研判；预警功能配置-5 分级告警与信息关联',
  '写操作，属性为下发处置单。须在测试环境验证权限与幂等行为后再放量，生产侧默认按开关控制；调用须记入操作审计。', 'POST + application/json'),
 ('分页查询事件（工单）', '/api/v1/application/citycasehandle/service/rs/case/v1/query',
  'caseNo（事件编号，支持模糊）、caseNos（多个逗号分隔）、cameraIndexCode、componentIds[]、caseTypeId、parentCaseType、orgIndexCode、containLowerOrg、alarmTimeStart/alarmTimeEnd、caseTimeStart/caseTimeEnd、alarmPlace、caseStatus（事件状态）、pageNo（必填）、pageSize（必填）',
  'code、msg、data.total、data.list[].caseNo、caseType、caseTypeName、caseStatus、caseStatusName、chargePerson、chargePersonName、chargePersonPhone、cameraIndexCode、cameraName、presetCode、alarmPlace、alarmTime、startTime、endTime、limitEndTime、limitTimeStr、remark、remainTime、dealTime、alarmPicUrl、overdue、caseFrom、starter、regionIndexCode、regionName、reportRemark',
  '工单看板 10min/次；事件复核按需', '15s',
  '幂等读接口，重试 2 次，间隔 3s、6s；单次查询跨度建议≤7天',
  '预警功能配置-5 分级告警与信息关联；预警功能配置-6 规则维护与运行追溯',
  '预警—处置闭环的落地凭证，与表二第 8 条积水事件生命周期记录互补（一条记录过程，一条记录工单结果）。', 'POST + application/json'),
 ('云台控制', '/api/video/v1/ptzs/controlling',
  'cameraIndexCode（监控点编号，必填）、action（0 开始/1 停止，必填）、command（控制命令，必填：LEFT/RIGHT/UP/DOWN/ZOOM_IN/ZOOM_OUT/FOCUS_NEAR/FOCUS_FAR/IRIS_ENLARGE/IRIS_REDUCE/GOTO_PRESET 等）、speed（云台速度 1-100，默认 40）、presetIndex（预置点编号 1-128，命令为 GOTO_PRESET 时必填）',
  'code、msg',
  '积水事件复核时按需调用', '10s',
  '非幂等写接口，超时后不自动重提；操作前先确认当前云台状态',
  '视频应用及联网管理-视频预览（云台控制）；预警功能配置-5 分级告警与信息关联',
  '用于积水事件复核时调整观察视角，须记录操作人与操作时间；与第 35 条配合实现易涝点固定视角一键定位。', 'POST + application/json'),
 ('查询预置点信息', '/api/video/v1/presets/searches',
  'cameraIndexCode（监控点唯一标识，必填）',
  'code、msg、data[].presetIndex、presetName 等预置点信息',
  '配置同步 1 次/日；首次配置时按需', '8s',
  '幂等读接口，重试 2 次，间隔 2s、5s',
  '视频应用及联网管理-视频预览（云台控制）',
  '取得各易涝点监控点已配置的预置点编号，供第 34 条 GOTO_PRESET 直接调用，避免人工现场对位。', 'POST + application/json'),
 ('按终端编号查询市政设备', '/api/bmunicipal/v1/artemis/device/findByDeviceNumber',
  'deviceNumber（终端编号，必填）',
  'code、msg、data（市政终端设备信息）',
  '设备接入核验时按需调用', '8s',
  '幂等读接口，重试 2 次，间隔 1s、3s',
  '监测设备接入管控；监测信息管理',
  '用于物联终端编号与平台设备台账的编码核对，解决同一设备在终端侧与平台侧编号不一致的问题。', 'POST + application/json'),
]

# ---------------------------------------------------------------- 表二新增
NEW2 = [
 (9, '积水事件接收（入站）', '/api/aiwater/v1/event/receive', 'POST + application/json',
  'eventId（事件标识，必填）、pointCode（点位编码）、stage（阶段：发现/复核/核销）、operator（操作人）、operateTime（操作时刻，ISO8601 或 Unix 秒）、conclusion（处置结论）、evidenceUrls[]（佐证材料地址）、rainScene（雨情场景）',
  'code、msg、data.accepted（本次写入条数）、duplicate（幂等命中条数）、signatureVerified（验签结果）、eventIds[]、receivedAt（接收时刻，真实 Unix 秒）',
  '异步（由基础平台回调本平台）',
  '预警功能配置-5 分级告警与信息关联；预警功能配置-6 规则维护与运行追溯',
  '本接口为入站方向：基础平台将积水事件的发现/复核/核销结果推送至本平台。单次请求可携带单条事件对象、事件数组或包装体；幂等键为（eventId, stage），重复推送不重复入库；请求头携带 X-AIWater-Signature（HMAC-SHA256）验签；响应 HTTP 状态码恒为 200，业务结果以响应体 code 表达（见约定第 16 条）。'),
]

# ---------------------------------------------------------------- 集成约定新增
NEW3 = [
 (13, '时间基准标注',
  '本平台内部以仿真时钟驱动（时间加速倍率为 60），因此所有含时间的对外响应与回调必须同时给出三项标注：timeBasis（simulated 仿真 / real 真实）、issuedAt（业务时钟，秒）、wallClock（真实 UNIX 时间戳，秒）。调用方不得将 issuedAt 直接写入基础平台的报警时间等时间字段，须改用 wallClock 或自行替换为真实时钟；入参中的 beginTime/endTime 一律按真实时钟（Asia/Shanghai）解释。'),
 (14, '风险等级映射',
  '本平台内部采用蓝、黄、橙、红四级预警等级，对外统一映射为高、中、低三级：黄→中；橙、红→高；蓝、无→低。对外响应同时保留原始四级字段（warnLevel），便于追溯与对账；映射关系如与基础平台口径不一致，以基础平台确认为准，只调映射表、不改动内部数据。'),
 (15, '预测结果幂等写入',
  '预测结果以（pointCode, period, modelVersion）作为幂等键：同一预见期重复发布时覆盖同一条记录并递增版本序号（revision），同时保留修正前数值与修正量（correction），形成可对照的修正轨迹。幂等键中不掺入发布时刻，避免同一预见期因多次发布产生多条并存记录；调用方按同一幂等键去重。'),
 (16, '入站事件回调',
  '基础平台回推积水事件（表二第 9 条）须满足四项要求：①请求头携带 X-AIWater-Signature，内容为共享密钥对请求体原文的 HMAC-SHA256（十六进制，兼容带 sha256= 前缀的写法）；②以（eventId, stage）为幂等键，重复推送不重复入库；③单次请求可携带单条事件对象、事件数组或 {list/events/data} 包装体，未约定字段一律忽略不入库；④响应 HTTP 状态码恒为 200，业务处理结果以响应体 code 表达。密钥通过环境变量注入，不写入代码与文档。'),
 (17, 'HTTP 方法口径',
  'Infovision iCM V3.0.0 接口文档未标注请求方法。本表按「参数位置」推断：参数位置为 Query 或 Head 的接口按 GET 处理（Query 传参、Head 传 Token），其余按 POST + application/json 处理。上述推断须在联调前逐条与基础平台确认，确认后以基础平台口径为准；调用方实现须保留方法可配置，不得写死。'),
 (18, 'ICM 文档字段口径偏差与联调前置核对',
  '基础平台提供的《Infovision iCM 智慧城管平台 V3.0.0 接口文档》存在以下已知偏差，本表已按可核对的信息逐条校正，联调前须以基础平台实际返回为准：①部分小节标题与接口地址错位（约 10 处，如「获取所有树编码」小节下给出的是设备实时数据接口地址）；②同一接口地址被多个不同标题复用；③个别路径前缀重复（如 /api/api/...）；④全文未标注 HTTP 请求方法；⑤未提供应用认证/Token 获取接口、事件类型号段与事件回调报文格式。凡涉及上述内容的接口，本表已在对应行的备注中标注，调用方不得对未明确的字段名做硬编码依赖。'),
]

# ---------------------------------------------------------------- 表一新增行的重试/频率已内联；下面组装
def cjk_lines(text, width, factor=2.05):
    if text is None:
        return 1
    n = 0
    for para in str(text).split('\n'):
        cpl = max(6, int(width / factor))
        n += max(1, math.ceil(len(para) / cpl))
    return max(1, n)


def fit_height(pairs, line_h, minimum=0.0):
    lines = 1
    for text, width in pairs:
        lines = max(lines, cjk_lines(text, width))
    return max(minimum, lines * line_h + 7)
