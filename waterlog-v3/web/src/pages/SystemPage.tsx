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

const APIS: { m: string; path: string; desc: string }[] = [
  { m: 'GET', path: '/api/health', desc: '链路健康、引擎轮次、待结算预测数' },
  { m: 'GET', path: '/api/overview', desc: '十站点的实测 + 研判合并视图（一张图数据源）' },
  { m: 'GET', path: '/api/sites', desc: '站点静态元数据（坐标、基准水位、四级阈值）' },
  { m: 'GET', path: '/api/sites/{id}', desc: '单站点详情：站点 + 历史 + 最新预测' },
  { m: 'GET', path: '/api/sites/{id}/history', desc: '近 N 小时水位与雨量序列' },
  { m: 'GET', path: '/api/forecast', desc: '全站点预测快照（四预见期 + 5min 曲线 + 研判）' },
  { m: 'GET', path: '/api/alerts', desc: '预警事件，支持 active_only=false 查历史' },
  { m: 'GET', path: '/api/alerts/{id}', desc: '单条预警 + 处置备注时间线' },
  { m: 'POST', path: '/api/alerts/{id}/ack', desc: '确认收到（四态推进，非法迁移返回 409）' },
  { m: 'POST', path: '/api/alerts/{id}/disposition', desc: '处置状态推进（五态，与四态独立）' },
  { m: 'GET', path: '/api/metrics', desc: '离线四模型指标、特征重要性、在线滚动评估' },
  { m: 'GET', path: '/api/models/versions', desc: '模型版本清单与当前激活版本' },
  { m: 'POST', path: '/api/models/adopt', desc: '采纳某个历史版本（先验证可加载）' },
  { m: 'GET', path: '/api/rules', desc: '当前研判规则' },
  { m: 'POST', path: '/api/rules/preview', desc: '用同一条已发布曲线预演规则改动的影响' },
  { m: 'GET', path: '/api/events', desc: 'SSE：telemetry / forecast / warning / rules' },
  { m: 'POST', path: '/api/sim/storm', desc: '注入一段降雨过程（peak mm/h × dur 步）' },
  { m: 'POST', path: '/api/sim/reset-water', desc: '排空积水并终止降水，用于验证解除路径' },
]

export function SystemPage() {
  const health = useHealth()
  const live = useLive()
  const retrain = useRetrainStatus()
  const storm = useSimStorm()
  const resetWater = useResetWater()
  const [msg, setMsg] = useState<string | null>(null)

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
      <div className="card p-4">
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
              <div
                className="rounded-control px-3 py-2 flex-1 min-w-0"
                style={{ background: T.bgCanvas, boxShadow: `inset 3px 0 0 ${l.ok ? l.color : T.level.red}` }}
              >
                <div className="flex items-center gap-1.5">
                  <Icon name={l.icon} size={12} className="shrink-0" />
                  <span className="text-[12px] font-medium text-ink truncate">{l.title}</span>
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0 ml-auto"
                    style={{ background: l.ok ? '#34d399' : T.level.red }}
                  />
                </div>
                <div className="text-[10.5px] text-ink-3 truncate mt-0.5">{l.sub}</div>
                <div className="text-[10px] text-ink-3 num">{l.port}</div>
              </div>
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
            <span className="num"> 仿真时钟 </span>
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
        <div className="card p-4">
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
            排空会把水位归零、清空雨云，并且**作废未结算的预测**——否则那些瞄着被抹掉的洪水的预测会被结算成漂亮数字，
            把在线 skill 抬成假的。生产环境应该整段删掉。
          </div>
        </div>
      </div>

      {/* 接口清单 */}
      <div className="card p-4">
        <SectionHead title="接口清单" sub="前端只通过这 18 个端点与后端交互" icon="layers" />
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
                <tr key={a.m + a.path} className="row-hover">
                  <td className="td">
                    <MethodBadge m={a.m} />
                  </td>
                  <td className="td mono text-[11.5px]">{a.path}</td>
                  <td className="td text-[12px] text-ink-2">{a.desc}</td>
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
