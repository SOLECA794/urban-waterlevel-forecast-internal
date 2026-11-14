# -*- coding: utf-8 -*-
"""把「演练/演示/demo」这类语境改成交付级表述。

原则：
  - 系统里确实存在的能力（注雨、排空、仿真时钟）保留，但不再自称「演练」
  - 说清楚它在**生产环境里的定位**（验收/运维调试通道，默认关闭）
  - 不再出现「让演示不必等雨」這種為投標現場服務的措辭
"""
import io, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
applied = []
skipped = []


def patch(path, pairs):
    p = os.path.join(ROOT, path)
    s = io.open(p, encoding='utf-8').read()
    orig = s
    for old, new in pairs:
        if old not in s:
            skipped.append((path, old[:60]))
            continue
        s = s.replace(old, new, 1)
    if s != orig:
        io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
        applied.append((path, len(orig), len(s)))
    else:
        skipped.append((path, 'NO CHANGE'))


# ---------------- Python 引擎 ----------------
patch('engine/waterlog/api/app.py', [
    ('''    """演练用：立刻注入一场暴雨。

    真实系统里没有这个接口（雨是天上下的），这里是为了让演示不必等雨：
    注入后 1~3 分钟内就能看到预警从“无”升到黄/橙，退水后再转“已解除”，
    完整走一遍四态闭环。
    """''',
     '''    """立即注入一段降雨过程（验收与调试通道，生产部署默认不开放）。

    真实降水由气象源驱动，这个接口只用于在没有降雨条件时验证
    「阈值触发 → 分级预警 → 退水解除」这条链路的完整性。
    """'''),
    ('''    """演练用：把所有站点积水清零，并立刻重算一轮研判。

    注入暴雨后水位会在阈值之上待十几个小时（管网满负荷、退水慢），
    验收四态闭环时不必干等：clear_sky=True 顺带把天上的雨停掉，
    这样「升 → 解除」整个过程几分钟内就能确定性地走完。
    """''',
     '''    """把所有站点积水清零并立即重算一轮研判（验收与调试通道）。

    退水过程受管网排水能力限制，实战中会在阈值之上持续数小时；
    验收链路时需要可重复的确定性条件：clear_sky=True 同时终止降水过程，
    使「抬升 → 解除」的完整状态迁移可在受控时间内复现。
    """'''),
])

patch('engine/waterlog/domain/hydrology.py', [
    ('# 演练清零后保证的干窗口长度（步）：60 步 = 5 小时，足够让水位落回阈值以下',
     '# 清零后保证的干窗口长度（步）：60 步 = 5 小时，足够让水位落回阈值以下'),
    ('''        """演练用：在当前时刻插入一场暴雨。''',
     '''        """在当前时刻插入一段降雨过程（验收通道用）。'''),
    ('''    def reset_water(self, clear_sky: bool = False) -> int:
        """演练用：把所有站点积水清零（视为已排空）。''',
     '''    def reset_water(self, clear_sky: bool = False) -> int:
        """把所有站点积水清零（视为已完成排水）。'''),
    ('真实系统当然没有这个能力，它存在的唯一目的是让四态闭环可被确定性验收。',
     '生产环境不提供该能力；它存在的唯一目的是让预警状态机可被确定性验证。'),
])

patch('engine/waterlog/infra/store.py', [
    ('演练清零会改写“世界状态”：清零前发布的预测，其目标时刻仍指向那条',
     '清零会改写世界状态：清零前发布的预测，其目标时刻仍指向那条'),
])

patch('engine/waterlog/service/forecast.py', [
    ('''否则刚启动的 1h 内修正强度是 0，演示时会显得"修正没生效"。"""''',
     '''否则刚启动的 1h 内修正强度为 0，在线修正看起来像没生效。"""'''),
])

# ---------------- Go ----------------
patch('api/internal/config/config.go', [
    ('// DefaultHost 默认只听本机：开发/演示都在同一台机器上，不需要对外。',
     '// DefaultHost 默认只听本机：引擎与 API 同机部署，无需对外暴露。'),
    ('// EngineURL Python 引擎地址，规则/重训/演练等请求反向代理过去。',
     '// EngineURL Python 引擎地址，规则/重训/控制类请求反向代理过去。'),
])

patch('api/internal/domain/user.go', [
    ('//	operator 值班员：确认预警、派单、推进处置、触发演练。一直在点。',
     '//	operator 值班员：确认预警、派单、推进处置、触发降雨过程注入。'),
])

patch('api/internal/icm/map.go', [
    ('TimeBasisSimulated TimeBasis = "simulated" // 对齐到 v3 仿真时钟（仅 demo 演示）',
     'TimeBasisSimulated TimeBasis = "simulated" // 对齐到 v3 仿真时钟（验收与联调用）'),
    ('ts = simTS // demo：整批对齐到当前仿真时刻，不引入真实时间污染',
     'ts = simTS // 整批对齐到当前仿真时刻，避免真实时间污染'),
])

patch('api/internal/service/engine.go', [
    ('// Go 侧不做任何计算：规则、模型版本、重训、演练注入这些请求全部原样转发，',
     '// Go 侧不做任何计算：规则、模型版本、重训、降雨注入这些请求全部原样转发，'),
    ('// PostEmpty 发一个无 body 的 POST（演练注入、重训这类"命令型"请求）。',
     '// PostEmpty 发一个无 body 的 POST（注雨、重训这类"命令型"请求）。'),
])

patch('api/internal/service/sites.go', [
    ('// 内置站点副本：引擎没起来时 Go 也能独立运行（改前端样式、演示静态页面）。',
     '// 内置站点副本：引擎未就绪时 Go 仍可独立提供只读接口。'),
])

patch('api/internal/httpapi/engine.go', [
    ('// 规则、模型版本、重训、演练这些请求全部原样转发给 Python 引擎，',
     '// 规则、模型版本、重训、降雨注入这些请求全部原样转发给 Python 引擎，'),
    ('// command 转发一个无 body 的「命令型」POST（重训、演练注入、排空积水）。',
     '// command 转发一个无 body 的「命令型」POST（重训、注雨、排空积水）。'),
])

patch('api/internal/httpapi/router.go', [
    ('//	写入段   确认/派单/规则/模型/演练      —— operator 及以上',
     '//	写入段   确认/派单/规则/模型/注入      —— operator 及以上'),
])

patch('api/internal/httpapi/authmw.go', [
    ('	return "演练操作"', '	return "降雨过程注入"'),
])

patch('api/internal/httpapi/aiwater.go', [
    ('// 预警表在演示环境里是几十到几百条量级，这个上限足够；',
     '// 预警表常规量级为几十到几百条，这个上限足够；'),
])

patch('api/internal/httpapi/aiwater_envelope.go', [
    ('// token 为空时直接放行：本机演示时多配一个密钥只是多一处会配错的地方。',
     '// token 为空时直接放行：同机部署时多配一个密钥只是多一处会配错的地方。'),
])

patch('api/internal/httpapi/aiwater_event.go', [
    ('//    没配密钥时放行并标注 signatureVerified=false（本机演示态）；',
     '//    没配密钥时放行并标注 signatureVerified=false（同机联调态）；'),
    ('// 这是本机演示态的取舍——多配一个密钥只是多一处会配错的地方。',
     '// 这是同机联调态的取舍——多配一个密钥只是多一处会配错的地方。'),
])

patch('api/internal/httpapi/aiwater_task.go', [
    ('// 这是演示环境里唯一能看出「异步」的地方；真实环境里这一步被真正的计算占用。',
     '// 这是任务队列里唯一能看出「异步」的地方；生产环境这一步被真实计算占用。'),
])

patch('api/internal/httpapi/aiwater_test.go', [
    ('// 空 token = 放行（本机演示态）', '// 空 token = 放行（同机联调态）'),
])

patch('api/cmd/icm-pull/main.go', [
    ('//	--basis=simulated  对齐到 --sim-now 指定的仿真时刻（demo 演示用）',
     '//	--basis=simulated  对齐到 --sim-now 指定的仿真时刻（联调与验收用）'),
])

# ---------------- 前端 ----------------
patch('web/src/components/Layout.tsx', [
    ("hint: '链路、接口与暴雨演练'", "hint: '链路、接口与降雨注入'"),
])

patch('web/src/pages/SystemPage.tsx', [
    ("desc: '演练：注入一场暴雨（peak mm/h × dur 步）'",
     "desc: '注入一段降雨过程（peak mm/h × dur 步）'"),
    ("desc: '演练：排空积水并清空天空，用于验证解除路径'",
     "desc: '排空积水并终止降水，用于验证解除路径'"),
    ('{/* 演练 */}', '{/* 降雨注入 */}'),
    ('title="暴雨演练"', 'title="降雨过程注入"'),
])

patch('web/src/pages/AlertsPage.tsx', [
    ("? '可以切到「全部历史」看已解除的事件。想造一次演练，去系统状态页注入一场暴雨。'",
     "? '可以切到「全部历史」看已解除的事件。需要验证解除链路，可在系统状态页注入一段降雨过程。'"),
])

patch('web/src/domain/auth.ts', [
    (' * 各写一遍的结果是「界面上能点，点了 403」——这种错在演示时最难解释。',
     ' * 各写一遍的结果是「界面上能点，点了 403」——这种错在最需要它的时刻最难解释。'),
    ("operator: '确认预警、派单、推进处置、触发演练。一直在点。',",
     "operator: '确认预警、派单、推进处置、触发降雨注入。一直在点。',"),
    ("| 'sim:drill' // 触发暴雨演练（会污染评估口径，只给值班员）",
     "| 'sim:drill' // 降雨过程注入（会污染评估口径，只给值班员）"),
])

patch('web/src/data/client.ts', [
    ('// ---------------------------------------------------------------- 演练',
     '// ------------------------------------------------------- 降雨过程注入'),
])

patch('web/src/board/RealMap.tsx', [
    (' * 站点本身是抽象点位，演示可接受；接真实数据前必须纠偏或换 WGS84 瓦片源。',
     ' * 站点本身是抽象点位；接入真实数据前必须纠偏或换 WGS84 瓦片源。'),
])

patch('web/src/board/scenes.tsx', [
    ('// 演练用的「排空积水」会让水位在一格之内归零，直连会在图上画出一道垂直断崖，',
     '// 「排空积水」会让水位在一格之内归零，直连会在图上画出一道垂直断崖，'),
])

for p, a, b in applied:
    print(f'OK   {p}  {a}->{b}')
for p, o in skipped:
    print(f'SKIP {p}  {o}')
