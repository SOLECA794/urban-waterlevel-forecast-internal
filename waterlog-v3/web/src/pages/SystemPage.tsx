import { useState } from 'react'
import {
  allLinksUp,
  fmtTime,
  linkStatus,
  uptimeText,
  type SimTime,
} from '../domain'
import { useHealth, useResetWater, useRetrainStatus, useSimStorm } from '../data/queries'
import { useLive } from '../data/live'
import { KeyValue, Meter, SectionHead, Skeleton } from '../components/primitives/Bits'
import { StatCard } from '../components/primitives/Stat'
import { Icon, type IconName } from '../components/primitives/Icons'
import { Tag } from '../components/domain/LevelChip'
import { Glossary } from '../components/interactive/Tooltip'
import { Drawer, DrawerSection } from '../components/interactive/Drawer'
import { Emph } from '../components/primitives/Rich'
import { T } from '../utils/tokens'

/**
 * 系统状态。
 *
 * 这一页要回答的不是「服务活着吗」（顶栏一直在说），而是
 * 「如果我按某个按钮，谁会先挂、挂了之后哪些数字会停」。
 * 所以四层链路图放在最前面，而不是把三个绿点堆在角落。
 */

const FLOW: { n: string; title: string; out: string; icon: IconName }[] = [
  { n: '01', title: '多源数据融合', out: '降雨 / 积水 / 预报 → 一条时间轴', icon: 'database' },
  { n: '02', title: '统一特征工程', out: '47 维特征，四预见期共用一份', icon: 'layers' },
  { n: '03', title: '多预见期预测', out: '1h / 3h / 6h / 12h + 90% 区间', icon: 'cpu' },
  { n: '04', title: '滚动修正', out: '系统性偏差回灌，钳制在 3σ 内', icon: 'target' },
  { n: '05', title: '三因子研判', out: '峰值 × 持续 × 趋势 → 四级', icon: 'gauge' },
  { n: '06', title: '结果应用', out: '一张图 / 曲线 / 预警事件', icon: 'map' },
]

/**
 * 每一层挂了会发生什么。
 *
 * 这一栏不能只写「服务不可用」——那等于没说。要写的是**用户会看到什么**：
 * 数字停在某个时刻不动、还是整块变空、还是继续涨但涨得不对。
 * 这三者在屏幕上长得完全不一样，值班的人靠这个判断该找谁。
 */
const LAYERS: {
  key: string
  title: string
  symptom: string
  confirm: string
  fix: string
}[] = [
  {
    key: '数据源',
    title: '数据源（内置水文模拟器）',
    symptom:
      '一张图的「最近一次遥测」会停在某个时刻，之后所有数字都不动，但页面不会报错——' +
      '水位曲线是一条水平直线，而且「近 1h 变化」会慢慢变成 0。' +
      '最容易误判成「雨停了，水退完了」。',
    confirm:
      '看顶栏「待结算」是不是还在涨：引擎没拿到遥测就不再结算，待结算只增不减。' +
      '再看 /api/health 里 engine.last_ts 与仿真时钟的差有没有拉开。',
    fix:
      '模拟器进程重启即从 sim_clock.json 续跑，不会退回数据集末尾，所以停多久补多久不会断层。',
  },
  {
    key: 'Python 引擎',
    title: 'Python 引擎（特征 · 预测 · 研判）',
    symptom:
      '实测还在更新，但**预测那半边整块失联**：抽屉里的四个预见期变成「—」，' +
      '地图上的气泡只反映当前水位、不再有峰值。预警也不再新增（研判在引擎里），' +
      '已存在的预警会一直挂着不解除。',
    confirm:
      'Go API 的 /api/health 会返回 engine_ok=false（这条判定同时证明「网关→引擎」这个方向通了没有）。' +
      '顶栏「Python 引擎」变成离线。',
    fix:
      '先看引擎日志最后一条特征是否完整（47 维缺一维会整轮失败），再重启；' +
      '重启后第一轮预测会补齐当前时刻的快照，历史预测不会重算。',
  },
  {
    key: 'Go API',
    title: 'Go API（落库 · 四态 · SSE）',
    symptom:
      '整页转圈然后报错——这个最不容易误判，因为它连不上就一个数字都没有。' +
      '但有一种半死状态要小心：API 活着、SSE 断了，页面看着正常但**不会自己刷新**，' +
      '要手动刷新才看到新数据。',
    confirm:
      '顶栏右侧「SSE 通/断」是判据。断的时候 /api/* 还是 200，所以只看接口会以为一切正常。',
    fix:
      'SSE 是长连接，反向代理的读超时设小了会周期性被掐；本项目有意不设 WriteTimeout 就是为这个。',
  },
  {
    key: '浏览器',
    title: '浏览器（React + ECharts）',
    symptom:
      '只有当前这个标签页坏了：别的浏览器、别的机器都正常。' +
      '典型是小毛病——地图瓦片加载不出来（外网断）、ECharts 画布高度算成 0（容器还在动就渲染）、' +
      '或者登录态过期后所有请求 401 但页面停在旧数据上。',
    confirm:
      '开一个无痕窗口重登。无痕里正常 = 本地缓存或登录态的问题，不是服务端。',
    fix:
      '退出重登（清 cookie）；瓦片问题看是不是内网出不去；画布高度问题刷新一次即可。',
  },
]

const APIS: { m: string; path: string; desc: string; auth: string; sample?: string }[] = [
  { m: 'GET', path: '/api/health', desc: '链路健康、引擎轮次、待结算预测数', auth: '匿名可读', sample: '{ api_ok, engine_ok, engine: { cycles, pending, uptime_s, model_version, last_ts } }' },
  { m: 'GET', path: '/api/overview', desc: '十站点的实测 + 研判合并视图（一张图数据源）', auth: '需登录', sample: '{ issued_at, sites: [{ site_id, name, lon, lat, base_level, thresholds, level, depth, rain, warn_level, warn_score, peak_value, duration_min, spark[20] }] }' },
  { m: 'GET', path: '/api/sites', desc: '站点静态元数据（坐标、基准水位、四级阈值）', auth: '需登录', sample: '[{ site_id, name, district, lon, lat, base_level, thresholds: { blue, yellow, orange, red }, kind }]' },
  { m: 'GET', path: '/api/sites/{id}', desc: '单站点详情：站点 + 历史 + 最新预测', auth: '需登录', sample: '{ site, history, forecast }' },
  { m: 'GET', path: '/api/sites/{id}/history?hours=N', desc: '近 N 小时水位与雨量序列', auth: '需登录', sample: '{ site_id, hours, points: [{ ts, level, rain }] }　注意键是 points 不是 sites' },
  { m: 'GET', path: '/api/forecast', desc: '全站点预测快照（四预见期 + 5min 曲线 + 研判）', auth: '需登录', sample: '{ issued_at, model_version, step_min, sites: { S07: { now_level, horizons[4], curve[145] } } }　curve 元素是 [offsetMin, level, lower, upper]' },
  { m: 'GET', path: '/api/alerts', desc: '预警事件，支持 active_only=false 查历史', auth: '需登录', sample: '{ alerts: [{ id, site_id, state, disposition, level, raised_at, note_count }] }' },
  { m: 'GET', path: '/api/alerts/{id}', desc: '单条预警 + 处置备注时间线', auth: '需登录' },
  { m: 'POST', path: '/api/alerts/{id}/ack', desc: '确认收到（四态推进，非法迁移返回 409）', auth: '需登录（operator 以上）', sample: '成功 { ok: true, state } ｜ 重复确认 409 { error: "已确认，无需重复确认" }' },
  { m: 'POST', path: '/api/alerts/{id}/disposition', desc: '处置状态推进（五态，与四态独立）', auth: '需登录（operator 以上）', sample: '合法迁移才 200；dispatched→open 刻意不允许，返回 409' },
  { m: 'GET', path: '/api/metrics', desc: '离线四模型指标、特征重要性、在线滚动评估', auth: '需登录', sample: '{ models: [...], importance: [...], rolling: { "60": { n, rmse, baseline_rmse, skill } } }' },
  { m: 'GET', path: '/api/models/versions', desc: '模型版本清单与当前激活版本', auth: '需登录', sample: '{ active, versions: [{ version, trained_at, n_train, metrics }] }' },
  { m: 'POST', path: '/api/models/adopt?version=', desc: '采纳某个历史版本（先验证可加载）', auth: '需登录（admin）', sample: '先验证 pickle 能不能加载再切换；加载失败不改当前版本' },
  { m: 'GET', path: '/api/rules', desc: '当前研判规则', auth: '需登录', sample: '{ weights: { peak, duration, trend }, levels: { blue, yellow, orange, red } }' },
  { m: 'POST', path: '/api/rules/preview', desc: '用同一条已发布曲线预演规则改动的影响', auth: '需登录（operator 以上）', sample: '{ before, after, up, down, changes }　不重新预测，所以变化一定来自规则' },
  { m: 'GET', path: '/api/events', desc: 'SSE：telemetry / forecast / warning / rules', auth: '需登录', sample: 'text/event-stream，事件 type 有 telemetry / forecast / warning / rules' },
  { m: 'POST', path: '/api/sim/storm?peak=&dur=', desc: '注入一段降雨过程（peak mm/h × dur 步）', auth: '需登录（admin）', sample: '{ ok, storm: { start_step, dur_steps, peak_mm_h, sim_minutes } }' },
  { m: 'POST', path: '/api/sim/reset-water', desc: '排空积水并终止降水，用于验证解除路径', auth: '需登录（admin）', sample: '{ ok, sites, dropped_pending, clear_sky }　会作废未结算预测' },
]

export function SystemPage() {
  const health = useHealth()
  const live = useLive()
  const retrain = useRetrainStatus()
  const storm = useSimStorm()
  const resetWater = useResetWater()
  const [msg, setMsg] = useState<string | null>(null)
  // 两个抽屉互斥：同时开两个面板比不开更糟
  const [layer, setLayer] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState<string | null>(null)

  const h = health.data
  const links = linkStatus(h, live.connected)
  const engine = h?.engine
  const cyclesPct = engine ? Math.min(100, (engine.cycles / 60) * 100) : 0

  const doStorm = (peak: number, label: string) => {
    setMsg(null)
    storm.mutate(
      { peak, dur: 30 },
      {
        onSuccess: (r) =>
          setMsg(
            `已注入${label}：${r.storm.peak_mm_h} mm/h，持续 ${r.storm.sim_minutes} 分钟仿真时间（${r.storm.dur_steps} 步）。约 30 秒后一张图开始变色。`,
          ),
        onError: (e) => setMsg(`注入失败：${(e as Error).message}`),
      },
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3 stagger">
        <StatCard
          label="Go API"
          value={h?.apiOk ? '在线' : '离线'}
          icon="activity"
          tone={h?.apiOk ? 'blue' : 'red'}
          footer={h?.service ?? '—'}
        />
        <StatCard
          label="Python 引擎"
          value={h?.engineOk ? '在线' : '离线'}
          icon="cpu"
          tone={h?.engineOk ? 'blue' : 'red'}
          footer={engine ? `已跑 ${engine.cycles} 轮 · 待结算 ${engine.pending}` : '未连通'}
        />
        <StatCard
          label="SSE 客户端"
          value={h?.clients ?? 0}
          unit="个"
          icon="wifi"
          tone="neutral"
          footer={live.connected ? `本页已收 ${live.events} 个事件` : '连接断开，正在重连'}
        />
        <StatCard
          label="模型版本"
          value={engine?.modelVersion || '—'}
          icon="target"
          tone="neutral"
          footer={engine?.uptimeS ? `引擎已运行 ${uptimeText(engine.uptimeS)}` : undefined}
        />
      </div>

      {/* 四层链路 */}
      <div className="card p-4" data-tour="system-chain">
        <SectionHead
          title="四层链路"
          sub="任何一层断了，后面的数字都会停止更新但不会报错 —— 这就是需要显式看链路的原因"
          icon="activity"
          right={
            <Tag tone={allLinksUp(links) ? 'ok' : 'danger'}>
              {allLinksUp(links) ? '全链路正常' : '有环节异常'}
            </Tag>
          }
        />
        <div className="flex items-stretch gap-2 mt-2">
          {(
            [
              { title: '数据源', sub: '内置水文模拟器', port: '60× 加速', ok: true, color: T.level.orange, icon: 'droplet' as IconName },
              { title: 'Python 引擎', sub: '特征 · 预测 · 研判', port: ':8201', ok: links.engine === 'up', color: T.ai, icon: 'cpu' as IconName },
              { title: 'Go API', sub: '落库 · 四态 · SSE', port: ':8200', ok: links.api === 'up', color: T.primary, icon: 'database' as IconName },
              { title: '浏览器', sub: 'React + ECharts', port: 'SSE', ok: links.stream === 'up', color: T.text2, icon: 'wifi' as IconName },
            ] as const
          ).map((l, i) => (
            <div key={l.title} className="flex items-center gap-2 flex-1 min-w-0">
              {/* 一层点开一个抽屉：挂了会看到什么现象 —— 这是值班时真正要判的东西 */}
              <button
                type="button"
                onClick={() => {
                  setApiKey(null)
                  setLayer(l.title)
                }}
                data-layer={l.title}
                title={`点开看「${l.title}挂了会怎样」`}
                className="rounded-control px-3 py-2 flex-1 min-w-0 text-left transition-transform duration-150 hover:-translate-y-px active:translate-y-0"
                style={{
                  background: T.bgCanvas,
                  boxShadow: `inset 3px 0 0 ${l.ok ? l.color : T.level.red}`,
                  border: '1px solid transparent',
                }}
              >
                <div className="flex items-center gap-1.5">
                  <Icon name={l.icon} size={12} className="shrink-0" />
                  <span className="text-[12px] font-medium text-ink truncate">{l.title}</span>
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0 ml-auto"
                    style={{ background: l.ok ? '#34d399' : T.level.red }}
                  />
                </div>
                <div className="text-[10.5px] text-ink-3 truncate mt-0.5">
                  {l.sub} · 点开看现象
                </div>
                <div className="text-[10px] text-ink-3 num">{l.port}</div>
              </button>
              {i < 3 && <Icon name="chevronRight" size={13} className="text-ink-3 shrink-0" />}
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-[1fr_1fr] gap-4 items-start">
        {/* 运行状态 */}
        <div className="card p-4">
          <SectionHead title="运行状态" sub="时间轴、落盘与保留策略" icon="clock" />
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-1">
            <KeyValue k="仿真时钟" v={h?.now ? fmtTime(h.now as SimTime, 'MM-DD HH:mm:ss') : '—'} />
            <KeyValue k="引擎轮次" v={engine ? String(engine.cycles) : '—'} />
            <KeyValue k="待结算预测" v={engine ? String(engine.pending) : '—'} />
            <KeyValue k="引擎运行时长" v={engine?.uptimeS ? uptimeText(engine.uptimeS) : '—'} />
            <KeyValue k="最近遥测" v={engine?.lastTs ? fmtTime(engine.lastTs as SimTime, 'MM-DD HH:mm:ss') : '—'} />
            <KeyValue k="重训状态" v={retrain.data ? retrainLabel(retrain.data.status) : '—'} />
          </div>

          <div className="mt-3">
            <div className="flex items-center justify-between text-[11px] text-ink-3 mb-1">
              <span>引擎已跑轮次（每 60s 一轮预测）</span>
              <span className="num">{engine?.cycles ?? 0} / 60</span>
            </div>
            <Meter value={cyclesPct} color={T.ai} />
          </div>

          <div className="mt-3 rounded-control px-3 py-2 text-[11.5px] text-ink-2 leading-relaxed" style={{ background: T.bgCanvas }}>
            <div className="font-medium text-ink mb-1">为什么时间轴这么麻烦</div>
            模拟器以 60 倍速推进，仿真时间会跑到墙钟前面。所有「近 N 小时」的窗口都必须按
            <Glossary term="仿真时钟" />
            算，用 <span className="num">time.Now()</span> 会把 1 小时算成 1 天，趋势斜率直接失真。
            引擎重启时从 <span className="num">sim_clock.json</span> 续跑，不会退回到数据集末尾。
          </div>

          <div className="mt-2 rounded-control px-3 py-2 text-[11.5px] text-ink-2 leading-relaxed" style={{ background: T.bgCanvas }}>
            <div className="font-medium text-ink mb-1">落盘与保留</div>
            遥测与预测快照写 SQLite（WAL 模式），预警事件与其备注长期保留。
            遥测按 48 小时滚动清理，避免库无限增长。
          </div>
        </div>

        {/* 降雨注入 */}
        <div className="card p-4" data-tour="system-rain">
          <SectionHead
            title="降雨过程注入"
            sub="模拟器按真实节奏下雨，等雨来要几个小时，所以给一个注入入口"
            icon="zap"
          />
          <div className="flex flex-wrap gap-2 mt-1">
            <button className="btn" disabled={storm.isPending} onClick={() => doStorm(40, '中雨')}>
              <Icon name="rain" size={13} /> 中雨 40
            </button>
            <button className="btn" disabled={storm.isPending} onClick={() => doStorm(90, '大雨')}>
              <Icon name="rain" size={13} /> 大雨 90
            </button>
            <button className="btn btn-primary" disabled={storm.isPending} onClick={() => doStorm(170, '暴雨')}>
              <Icon name="zap" size={13} /> 暴雨 170
            </button>
            <button
              className="btn btn-danger"
              disabled={resetWater.isPending}
              onClick={() =>
                resetWater.mutate(undefined, {
                  onSuccess: (r) =>
                    setMsg(
                      `已排空积水并清空天空：${r.sites} 个站点回到基准水位，作废 ${r.dropped_pending} 条未结算预测。约 8 秒后预警全部解除。`,
                    ),
                  onError: (e) => setMsg(`排空失败：${(e as Error).message}`),
                })
              }
            >
              <Icon name="refresh" size={13} /> 排空积水
            </button>
          </div>

          {msg && (
            <div className="mt-2 rounded-control px-3 py-2 text-[11.5px] leading-snug flex items-start gap-2" style={{ background: T.aiWeak, color: T.aiInk }}>
              <Icon name="info" size={13} className="mt-0.5 shrink-0" />
              <span>{msg}</span>
            </div>
          )}

          <div className="mt-2 rounded-control px-3 py-2 text-[11.5px] text-ink-2 leading-relaxed" style={{ background: T.bgCanvas }}>
            <div className="font-medium text-ink mb-1">为什么需要一个「排空积水」这种假接口</div>
            这个模型的退水很慢：管网满负荷排水加上漫溢拓宽，0.7m 积水退到阈值以下要 11 小时仿真时间，
            也就是墙钟 11 分钟。验证「预警解除」这条路径不能靠等。
            <Emph text="排空会把水位归零、清空雨云，并且**作废未结算的预测**——否则那些瞄着被抹掉的洪水的预测会被结算成漂亮数字，把在线 skill 抬成假的。生产环境应该整段删掉。" />
          </div>
        </div>
      </div>

      {/* 接口清单 */}
      <div className="card p-4">
        <SectionHead
          title="接口清单"
          sub="前端只通过这些端点与后端交互 · 点任意一行看返回结构与失败态"
          icon="layers"
        />
        <div className="overflow-x-auto mt-1">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th w-[64px]">方法</th>
                <th className="th w-[240px]">路径</th>
                <th className="th">说明</th>
              </tr>
            </thead>
            <tbody>
              {APIS.map((a) => (
                <tr
                  key={a.m + a.path}
                  className="row-hover cursor-pointer"
                  data-api={a.m + ' ' + a.path}
                  onClick={() => {
                    setLayer(null)
                    setApiKey(a.m + ' ' + a.path)
                  }}
                >
                  <td className="td">
                    <MethodBadge m={a.m} />
                  </td>
                  <td className="td mono text-[11.5px]">{a.path}</td>
                  <td className="td text-[12px] text-ink-2">
                    {a.desc}
                    <span className="ml-2 text-[10.5px]" style={{ color: T.text3 }}>
                      {a.auth}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 算法链路 */}
      <div className="card p-4">
        <SectionHead title="算法链路" sub="六段，每段的输入输出都可核验" icon="cpu" />
        <div className="grid grid-cols-3 gap-2.5 mt-1">
          {FLOW.map((f) => (
            <div key={f.n} className="rounded-control p-2.5" style={{ background: T.bgCanvas }}>
              <div className="flex items-center gap-1.5">
                <span className="num text-[10px] text-ink-3">{f.n}</span>
                <Icon name={f.icon} size={12} className="text-ink-2" />
                <span className="text-[12px] font-medium text-ink">{f.title}</span>
              </div>
              <div className="text-[10.5px] text-ink-3 mt-1 leading-snug">
                <span style={{ color: T.aiInk }}>→ </span>
                {f.out}
              </div>
            </div>
          ))}
        </div>
      </div>

      {health.isLoading && (
        <div className="space-y-2">
          <Skeleton h={20} />
          <Skeleton h={20} w="70%" />
        </div>
      )}

      {/* 链路层：挂了会看到什么 */}
      <Drawer
        open={layer != null}
        onClose={() => setLayer(null)}
        title={layer ? (LAYERS.find((x) => x.key === layer)?.title ?? layer) : ''}
        subtitle="这一层断开时，屏幕上会先出现什么"
        width={520}
      >
        {(() => {
          const d = LAYERS.find((x) => x.key === layer)
          if (!d) return null
          return (
            <>
              <DrawerSection title="现象">
                <p className="text-[12.5px] leading-relaxed text-ink-2 m-0">
                  <Emph text={d.symptom} strong={{ color: T.text1 }} />
                </p>
              </DrawerSection>
              <DrawerSection title="怎么确认是它">
                <p className="text-[12.5px] leading-relaxed text-ink-2 m-0">
                  <Emph text={d.confirm} strong={{ color: T.text1 }} />
                </p>
              </DrawerSection>
              <DrawerSection title="恢复">
                <p className="text-[12.5px] leading-relaxed text-ink-2 m-0">
                  <Emph text={d.fix} strong={{ color: T.text1 }} />
                </p>
              </DrawerSection>
            </>
          )
        })()}
      </Drawer>

      {/* 接口：返回什么、要不要鉴权、失败什么样 */}
      <Drawer
        open={apiKey != null}
        onClose={() => setApiKey(null)}
        title={apiKey ?? ''}
        subtitle="返回结构 · 鉴权要求 · 失败态"
        width={560}
      >
        {(() => {
          const a = APIS.find((x) => x.m + ' ' + x.path === apiKey)
          if (!a) return null
          return (
            <>
              <DrawerSection title="用途">
                <p className="text-[12.5px] leading-relaxed text-ink-2 m-0">{a.desc}</p>
              </DrawerSection>
              <DrawerSection title="鉴权">
                <div className="flex items-center gap-2">
                  <Tag tone={a.auth.includes('admin') ? 'danger' : a.auth.includes('匿名') ? 'ok' : 'neutral'}>
                    {a.auth}
                  </Tag>
                  <span className="text-[11.5px]" style={{ color: T.text3 }}>
                    {a.m === 'GET'
                      ? '读接口，失败时返回 { error } 而不是空数组'
                      : '写接口，越权返回 403，非法状态迁移返回 409 并带原话'}
                  </span>
                </div>
              </DrawerSection>
              {a.sample && (
                <DrawerSection title="返回结构">
                  <pre
                    className="text-[11.5px] leading-relaxed m-0 p-2.5 rounded-control overflow-x-auto"
                    style={{ background: T.bgCanvas, color: T.text2 }}
                  >
                    {a.sample}
                  </pre>
                </DrawerSection>
              )}
              <DrawerSection title="自己试一下">
                <pre
                  className="text-[11.5px] leading-relaxed m-0 p-2.5 rounded-control overflow-x-auto"
                  style={{ background: T.bgCanvas, color: T.text2 }}
                >
                  {a.m === 'GET'
                    ? `curl -b cookie.txt ${'${BASE}'}${a.path.split('?')[0]}`
                    : `curl -b cookie.txt -X POST ${'${BASE}'}${a.path.split('?')[0]}`}
                </pre>
              </DrawerSection>
            </>
          )
        })()}
      </Drawer>
    </div>
  )
}

function MethodBadge({ m }: { m: string }) {
  const write = m !== 'GET'
  return (
    <span
      className="inline-flex items-center h-[18px] px-1.5 rounded text-[9.5px] font-semibold tracking-wide num"
      style={{
        background: write ? T.levelWeak.orange : T.levelWeak.blue,
        color: write ? T.levelInk.orange : T.levelInk.blue,
      }}
    >
      {m}
    </span>
  )
}

function retrainLabel(s: string): string {
  switch (s) {
    case 'idle':
      return '空闲'
    case 'running':
      return '训练中'
    case 'done':
      return '已完成'
    case 'error':
      return '失败'
    default:
      return s
  }
}
