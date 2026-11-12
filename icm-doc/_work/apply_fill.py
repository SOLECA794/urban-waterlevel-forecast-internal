# -*- coding: utf-8 -*-
"""应用补充：读基础版 -> 重建三个 sheet -> 另存补全版。"""
import math, sys, os
from copy import copy
import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
from openpyxl.utils import get_column_letter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fill_plan import SRC, OUT, T1, NEW1, NEW2, NEW3

THIN = Side(style='thin', color='FFBFBFBF')
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
HDR_FILL = PatternFill('solid', fgColor='FF2E75B6')
TITLE_FILL = PatternFill('solid', fgColor='FF1F4E79')
SUB_FILL = PatternFill('solid', fgColor='FFDDEBF7')
FONT = '微软雅黑'


def dwidth(s):
    if s is None:
        return 0
    return sum(2 if ord(ch) > 127 else 1 for ch in str(s))


def h_for(pairs, col_w, line_h=12.0, min_h=28.0):
    """pairs: [(text, col_width)] -> 行高"""
    lines = 1
    for text, w in pairs:
        for para in str(text or '').split('\n'):
            lines = max(lines, max(1, math.ceil(dwidth(para) / max(8.0, w))))
    return max(min_h, lines * line_h + 7.0)


W1 = {'B': 26.625, 'C': 42.625, 'D': 20.625, 'E': 40.625, 'F': 46.625,
      'G': 22.625, 'H': 14.625, 'I': 40.625, 'J': 34.625, 'K': 34.625}
W2 = {'B': 26.625, 'C': 42.625, 'E': 40.625, 'F': 46.625, 'G': 22.625,
      'H': 14.625, 'I': 34.625}
W3 = {'B': 26.625, 'C': 42.625}

wb = openpyxl.load_workbook(SRC)

# ============================================================== Sheet3 集成接口清单
ws = wb['集成接口清单']
print('K width before:', ws.column_dimensions['K'].width)
ws.column_dimensions['K'].width = 34.625

# 1) 抓原样式
def grab(ws, rows, ncol=11):
    keep = {}
    for r in rows:
        keep[r] = [copy(ws.cell(r, c)._style) for c in range(1, ncol + 1)]
    return keep

ST = grab(ws, list(range(1, 39)))
VAL = {r: [ws.cell(r, c).value for c in range(1, 12)] for r in range(1, 39)}
HGT = {r: ws.row_dimensions[r].height for r in range(1, 39)}

# 2) 组装新表
out = []          # (values[11], style_row, height_override_or_None)

def rd(r, n=11):
    v = list(VAL[r]) + [None] * (n - len(VAL[r]))
    return v[:n]

# r1 标题 / r2 表头
t1v = rd(1)
t1v[0] = '一、表一：AI水位预测及预警平台对基础平台的调用接口清单（36条）'
out.append((t1v, 1, HGT[1]))
out.append((rd(2), 2, HGT[2]))

# 表一 12 行（修正 E/F/K）
for r in range(3, 15):
    v = rd(r)
    e, f, note = T1[r]
    v[4] = e
    v[5] = f
    v[10] = note
    hh = h_for([(e, W1['E']), (f, W1['F']), (note, W1['K']),
                (v[6], W1['G']), (v[8], W1['I']), (v[9], W1['J'])], 0,
               line_h=11.6, min_h=28.5)
    out.append((v, r, hh))

# 表一 新增 24 行（序号 13..36）
for i, (name, addr, eargs, eouts, freq, tmo, retry, clause, note, method) in enumerate(NEW1):
    v = [13 + i, name, addr, method, eargs, eouts, freq, tmo, retry, clause, note]
    h = h_for([(eargs, W1['E']), (eouts, W1['F']), (freq, W1['G']),
               (retry, W1['I']), (clause, W1['J']), (note, W1['K'])], W1['E'])
    out.append((v, 3, h))

# 表二 标题 -> 行数改为 9
t2 = rd(15)
t2[0] = '二、表二：AI水位预测及预警平台对外服务接口清单（9条）'
out.append((t2, 15, HGT[15]))
out.append((rd(16), 16, HGT[16]))
for r in range(17, 25):
    out.append((rd(r), r, None))
for idx, name, addr, method, eargs, eouts, way, clause, note in NEW2:
    v = [idx, name, addr, method, eargs, eouts, way, clause, note] + [None, None]
    h = h_for([(eargs, W2['E']), (eouts, W2['F']), (clause, W2['H']), (note, W2['I'])], W2['E'])
    out.append((v, 17, h))

# 约定
out.append((rd(25), 25, HGT[25]))
out.append((rd(26), 26, HGT[26]))
for r in range(27, 39):
    out.append((rd(r), r, None))
for idx, item, content in NEW3:
    v = [idx, item, content] + [None] * 8
    h = h_for([(content, W3['C'])], W3['C'])
    out.append((v, 27, h))

# 3) 重写
for mr in list(ws.merged_cells.ranges):
    ws.unmerge_cells(str(mr))
maxr = ws.max_row
for r in range(1, maxr + 1):
    for c in range(1, 12):
        ws.cell(r, c).value = None
        ws.cell(r, c)._style = copy(ST[3][c - 1])

for i, (v, srow, h) in enumerate(out):
    r = i + 1
    for c in range(1, 12):
        cell = ws.cell(r, c)
        cell.value = v[c - 1]
        cell._style = copy(ST[srow][c - 1])
    ws.row_dimensions[r].height = h if h else HGT.get(srow)

n = len(out)
t1_end = 2 + 12 + len(NEW1)          # 表一最后一行
t2_start = t1_end + 1
t2_end = t2_start + 1 + 8 + len(NEW2)
t3_start = t2_end + 1
ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=11)
ws.merge_cells(start_row=t2_start, start_column=1, end_row=t2_start, end_column=9)
ws.merge_cells(start_row=t3_start, start_column=1, end_row=t3_start, end_column=3)
if ws.column_dimensions['K'].width is None:
    ws.column_dimensions['K'].width = 34.625
print('sheet3 rows:', n, 't1_end', t1_end, 't2', t2_start, t2_end, 't3', t3_start, 'total', n)

# ============================================================== Sheet2 可行性分析
ws2 = wb['AI平台接口可行性分析']
V2 = {r: [ws2.cell(r, c).value for c in range(1, 11)] for r in range(1, 33)}
S2 = grab(ws2, list(range(1, 33)), 10)
H2 = {r: ws2.row_dimensions[r].height for r in range(1, 33)}

D2 = {
 8: '统一数据接入接口（HTTP+JSON，UTF-8，Token 鉴权）；设备与监测项字典接口 /api/cisrm/v1/device/types（取 monitorItemCode、dataType、unit）；动环阈值与历史数据接口 /api/pems/v1/public/sensor/threshold、/api/pems/v1/public/monitor/history/statistics/batch；区域与监控点接口 /api/resource/v1/regions、/api/resource/v1/cameras；设施类型接口 /api/cisrm/v1/facilities/types。跨网域（政务外网/视频专网）按单向光闸 + 数据交换通道交换',
 9: '时序与关系数据库读写（内部）；数据质量校验结果经设备报警配置接口 /api/cisrm/v1/device/queryAlarmConfig 与设施报警接口 /api/cisrm/v1/facilities/findAlarmByParams 回归业务侧；时间戳统一为 ISO 8601（yyyy-MM-ddTHH:mm:ss+08:00），毫秒时间戳仅在平台侧接口内使用',
 10: '模型服务调用接口（HTTP+JSON，UTF-8，Token 鉴权）；预测任务接口 /api/aiwater/v1/prediction/task/submit 与状态查询 /api/aiwater/v1/prediction/task/status（异步「提交—轮询/回调」）；结果查询 /api/aiwater/v1/prediction/result',
 11: '预测任务接口 /api/aiwater/v1/prediction/result：period 参数覆盖 1h/3h/6h/12h 四个预见期；滚动预测由定时任务触发；响应体统一为「点位 + 预见期 + 预测时间序列」结构',
 12: '预测结果与预警规则联合计算（内部）；风险等级四级→三级映射（黄→中，橙/红→高，蓝/无→低，同时保留原始四级字段）；风险等级字典经 /api/common/v1/dictionary/getFirstLayerByTypeCode 统一下发；结果查询 /api/aiwater/v1/risk/realtime',
 13: '实时数据订阅与轮询（设备实时数据 /api/cisrm/v1/device/queryRealtimeDataByPage）；预测结果更新 /api/aiwater/v1/prediction/result，按（pointCode, period, modelVersion）幂等写入并递增 revision；修正前数值与修正量（correction）同步保留',
 14: '结果查询接口（分页、按点位与时间过滤，/api/aiwater/v1/prediction/result、/api/aiwater/v1/warning/records）；时序数据接口；前端沿用平台门户与可视化组件；大时段查询须带采样降频与按点位索引优化',
 15: '统一软件服务接口（RESTful/HTTP+JSON，UTF-8）；网关统一鉴权（Token，兼容请求头 X-AIWater-Token 与 Authorization: Bearer）；统一响应包 {code, msg, data}；时间标注 timeBasis/issuedAt/wallClock',
 16: '任务运行管理接口 /api/aiwater/v1/prediction/task/status（queued/running/success/failed 四态，失败码 INPUT_MISSING/MODEL_UNAVAILABLE/TIMEOUT/QUOTA_EXCEEDED/INTERNAL）；预测运行记录 /api/aiwater/v1/waterlogging/event/lifecycle；输入缺失与异常经工单接口 /api/v1/application/citycasehandle/service/rs/case/v1/query 关联运维处置',
 17: '视频取流与回放接口 /api/video/v1/cameras/previewURLs、/api/video/v1/cameras/playbackURLs；录像完整性接口 /api/nms/v1/record/list（intactDuration/planDuration 用于样本质量打分）；云台与预置点接口 /api/video/v1/ptzs/controlling、/api/video/v1/presets/searches；时序数据经设备历史数据接口导出；样本元数据接口',
 18: '异步作业接口（提交—轮询—回调）；算力资源接口；过程记录与回调接口。协议为 HTTP+JSON；作业管理与算力配额接口须新增（当前 RFC 中无对应接口，属扩展项）',
 19: '批量推理接口；评估指标输出接口（MAE/RMSE/准确率/召回率）；样本回溯经设备历史数据接口 /api/cisrm/v1/device/queryHistoryDataByPage 与录像回放接口取数；结果以结构化指标输出，不进平台主库',
 20: '模型仓库与版本管理接口 /api/aiwater/v1/model/versions（action=list/switch，版本元数据含 taskType、deployTime、status）；切换为写操作须二次确认与操作审计。当前 ICM 文档无模型仓库类规范，属本平台侧新增能力',
 21: '推理服务接口（gRPC/HTTP+JSON，UTF-8）；标准推理协议（请求含点位、时段、输入特征；响应含预测序列与置信度）；平台侧服务注册与统一鉴权；视频取流复用平台取流解码通道',
 22: '大模型接口（HTTPS+JSON，可选 SSE 流式）；提示词与上下文管理；内容安全、限流与敏感字段脱敏；交互日志纳入审计。政务网络对外调用须先明确出口与数据出域策略，优先私有化部署',
 23: '运行监控接口（CPU/GPU/显存等资源指标）；模型调用记录；异常日志。指标可按 Prometheus 格式或自定义监控接口上报，复用平台运维模块的统计、告警与导出能力',
 24: '统一身份认证（Token，兼容 OAuth2 形态）；接口权限与数据域控制；审计日志；传输加密（HTTPS/TLS1.2 及以上）；验签（HMAC-SHA256）用于入站事件回调。所有模型服务调用纳入统一网关鉴权与审计',
}

H2_ADD = {
 2: '实现要点：①雨情场景字典由平台字典服务统一下发，禁止硬编码；②点位—规则关联表以点位编码（pointCode）与设备监测项编码（monitorItemCode）为外键；③字典新增走变更流程并保留版本。',
 3: '实现要点：①阈值对象与平台「设备类型—监测项—报警类型」三层模型通过外键直接关联，不新建数据模型；②设备侧既有报警条件由 /api/cisrm/v1/device/queryAlarmConfig 读取，作为阈值基线比对，避免两侧口径不一致；③分级阈值以配置数据下发，符合平台参数化配置规范。',
 4: '实现要点：①采用「事件驱动 + 定时校核」双机制切换阈值；②阈值读写与切换记录经平台操作日志留存，具备可追溯性；③对既有监测数据链路无侵入。',
 5: '实现要点：①规则判定服务订阅与平台同一路监测数据流，避免重复取数；②以滑动窗口 + 去抖策略抑制短时波动误报；③上行沿用平台既有报警事件协议，并在报文中以向后兼容方式追加雨情场景与适用阈值字段。',
 6: '实现要点：①事件模型与平台「视频报警联动」「报警事件中心」同构，复用事件订阅与推送通道；②事件报文追加字段须向后兼容，前端预警列表与详情页平滑扩展；③入站事件以（eventId, stage）为幂等键，验签使用 HMAC-SHA256。',
 7: '实现要点：①规则维护的操作授权依托平台用户、角色、权限体系；②日志落库并纳入统一审计，只需约定日志字段规范；③无需新增独立账号体系。',
 8: '实现要点：①须先取得设备与监测项字典（monitorItemCode/dataType/unit）才能正确解析监测值——原件中监测值字段名随监测项编码变化，且实时接口为 String 型、历史接口为 Number 型；②跨网域数据交换须评估单向光闸或数据交换通道的时延与丢包对滚动预测的影响；③物联数据接入采用统一 HTTP+JSON、UTF-8 编码。',
 9: '实现要点：①质量标记回写监测数据表，供监测信息管理与物联设备运维模块复用，实现数据质量问题闭环；②不同采样周期的数据须统一到同一时间栅格后再做序列对齐。',
 10: '实现要点：①以标准推理服务对接（请求含点位、时段、输入特征，响应含预测序列与置信度），平台侧仅做任务编排与结果入库，业务与算法解耦；②多模态大模型结果作为研判辅助，不直接决定预警等级。',
 11: '实现要点：①预见期作为请求参数由单接口覆盖多尺度输出，避免多套接口；②滚动预测以定时任务触发，结果按（pointCode, period, modelVersion）幂等写入。',
 12: '实现要点：①研判逻辑与预警阈值规则共用同一套配置数据，避免双份维护与口径不一致；②对外三级等级与原四级等级同时输出，便于对账；③风险等级字典与平台字典服务保持一致。',
 13: '实现要点：①结果版本化，保留修正前数值以便与实测值对照；②采用「点位 + 时段 + 模型版本」幂等写入，幂等键中不掺入发布时刻，避免同一预见期产生多条并存记录；③并发修正不覆盖历史轨迹。',
 14: '实现要点：①大时段查询须评估响应性能，增加采样降频参数与按点位索引优化；②预测值与实测值对照须以同一时间基准换算后再比对（本平台内部为仿真时钟）。',
 15: '实现要点：①预测服务按与平台一致的规范注册接入，实现服务复用与统一鉴权；②统一响应包 {code, msg, data}，code 为字符串，"0" 表示成功，严禁仅凭 HTTP 200 判成功；③含时间的响应统一标注时间基准。',
 16: '实现要点：①任务运行状态纳入既有运维看板展示；②输入数据缺失与异常提示生成工单，复用运维模块的转派与处置流程，减少新增页面与接口；③任务失败按失败码分类处置，超时与算力不足分别对应重排队与扩容。',
 17: '实现要点：①取流 URL 具时效性，禁止落库长期缓存，过期须重新获取；②下载前先用录像完整性接口确认片段完整，避免残缺样本污染训练集；③离线批量导出并做样本去重与场景分层抽样，控制带宽与存储成本。',
 18: '实现要点：①协议沿用 HTTP+JSON，但须新增作业管理与算力配额接口，属可控范围内的扩展；②训练任务与推理任务共享算力时须排队限流，避免抢占实时预测资源。',
 19: '实现要点：①通过批量推理 + 指标回算实现，无需改造平台主干；②评估结果以结构化指标输出，便于平台侧图表化展示与版本对比；③验证样本须与训练样本分离，避免自证。',
 20: '实现要点：①采用「模型 ID + 版本号」路由，平台侧仅保存引用与切换记录，降低集成面与运维复杂度；②切换为写操作，须二次确认与操作审计；③版本切换后保留回滚路径。',
 21: '实现要点：①本地推理以容器化服务部署，接口采用标准推理协议；②视频分析复用平台取流解码通道，避免重复建设；③算力可弹性扩容，容量按峰值并发预留。',
 22: '实现要点：①政务网络对外调用须评估出口与数据出域风险，优先私有化部署；②配置访问控制、限流与敏感信息脱敏，并纳入日志审计；③监测数据作为分析上下文时须做字段级脱敏。',
 23: '实现要点：①以标准指标上报接口或自定义监控接口对接，复用平台运维模块的统计、告警与导出能力；②资源使用情况与调用记录按任务维度留存，支持按时间与任务检索。',
 24: '实现要点：①可复用平台账号安全（MAC/IP 绑定、密码策略与有效期）、角色权限与门户配置能力；②所有模型服务调用纳入统一网关鉴权与审计；③入站回调须验签且密钥经环境变量注入，不写入代码与文档。',
}

NEW27 = 'AI水位预测及预警平台通过自研网关对外提供服务，接口前缀 /api/aiwater/v1（对外查询 8 条 + 入站事件接收 1 条，共 9 条；入站接口不校验 Token，改用共享密钥签名 X-AIWater-Signature）。网关统一鉴权（X-AIWater-Token 或 Authorization: Bearer）、统一响应包 {code, msg, data}（code 为字符串，"0" 表示成功）、统一时间基准标注（timeBasis/issuedAt/wallClock）、统一分页（pageNo/pageSize/total/list）。基础平台可经表二 9 条接口取用本平台能力；本平台对基础平台的反向调用共 36 条，见表一。'
NEW30 = '①雨情场景字典与点位—规则关联表；②预警事件报文扩展雨情场景、适用阈值与时间基准字段；③训练作业与算力配额管理接口；④模型仓库与版本管理接口；⑤在线大模型出口与安全策略；⑥入站事件回调的验签与幂等；⑦对外三级风险等级与内部四级预警等级的映射表。均为接口级增量，不影响既有版本兼容。'
NEW32 = '23 项功能条款中，技术可行性「高」15 项、「中高」6 项、「中」2 项，无不可行项；平台支持性以「完全支持/支持」为主，需扩展部分集中在 AI 算力与模型管理侧，属可控范围。本平台对基础平台共需调用 36 条接口（原有 12 条的入参与出参字段已全部按原件核对并修正，新增 24 条补齐字典、阈值、设施报警、字典服务、订阅核对、工单与视频控制能力），对外提供 9 条服务接口，并约定 18 项集成规则。建议按「接入层—数据层—算法层—应用层」四层推进，先完成雨情场景与阈值规则、事件回传的试点对接。'

for r in range(1, 33):
    for c in range(1, 11):
        cell = ws2.cell(r, c)
        cell._style = copy(S2[r][c - 1])
    ws2.row_dimensions[r].height = H2[r]

for r, txt in D2.items():
    ws2.cell(r, 4).value = txt
    ws2.row_dimensions[r].height = h_for([(txt, 40.625), (V2[r][6], 62.625)], 0, line_h=12.0, min_h=72.0)
for r, txt in H2_ADD.items():
    ws2.cell(r, 8).value = txt
    ws2.cell(r, 8).alignment = Alignment(vertical='top', wrap_text=True)
    ws2.cell(r, 8).font = Font(name=FONT, size=9)
    ws2.cell(r, 8).border = BORDER
    ws2.row_dimensions[r].height = max(ws2.row_dimensions[r].height or 0,
                                       h_for([(txt, 22.0)], 0, line_h=11.0, min_h=72.0))
ws2.cell(1, 8).value = '落地实现要点'
ws2.cell(1, 8)._style = copy(S2[1][0])
ws2.column_dimensions['H'].width = 22.0
ws2.cell(27, 2).value = NEW27
ws2.cell(30, 2).value = NEW30
ws2.cell(32, 2).value = NEW32
for r in (27, 30, 32):
    ws2.row_dimensions[r].height = h_for([(ws2.cell(r, 2).value, 62.625)], 0, line_h=12.0, min_h=54.0)
print('sheet2 done')

wb.save(OUT)
print('saved', OUT, os.path.getsize(OUT))
