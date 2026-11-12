import type { Palette } from './theme'
import type { AuditEntry, Delivery, Level, ModelVersion, SystemHealth } from '../domain'

/**
 * 「平台运行」屏的四个面板。
 *
 * 这一屏不再讲水位。前三屏（总览 / 分区 / 图表）已经把「城里现在怎么样、
 * 模型靠不靠得住」讲完了，再放残差散点或精度矩阵只是重复。
 * 这一屏回答的是另一个问题：**这套系统本身今天转得怎么样** ——
 * 收了多少数、断了几个点、推了多少条通知、谁在动配置、服务有没有卡。
 *
 * 数据源刻意都是「运行记录」而不是「监测值」：审计流水、通知投递、模型版本、
 * 引擎心跳。它们平时散在管理页里，只有出事才会被翻，但在大屏上它们是
 * 「平台在用、有人管」的证据。
 */

/**
 * 数据质量看板：十个站里几个在正常上报。
 *
 * 为什么单独做一块：水位大屏最容易骗人的地方，是引擎挂了两小时、
 * 画面上十个站还在显示旧数据。这块把「多久没更新」直接摆出来，
 * 观众能自己判断上面那些数字还算不算数。
 */
export interface QualitySiteRow {
  readonly siteId: string
  readonly name: string
  readonly district: string
  readonly level: Level
  /** 已多少秒没有新读数 */
  readonly staleSec: number
  /** 数字质量：good / suspect / bad */
  readonly quality: string
}

export function QualityPanel({
  rows,
  health,
  p,
}: {
  rows: readonly QualitySiteRow[]
  health: SystemHealth
  p: Palette
}) {
  const total = rows.length || 1
  const fresh = rows.filter((r) => r.staleSec < 120).length
  const stale = rows.filter((r) => r.staleSec >= 120 && r.staleSec < 900).length
  const dead = rows.filter((r) => r.staleSec >= 900).length
  const suspect = rows.filter((r) => r.quality !== 'good').length
  const upMin = Math.floor(health.engine.uptimeS / 60)

  const slots = [
    { label: '新鲜（<2min）', n: fresh, color: p.level.blue },
    { label: '滞后（2~15min）', n: stale, color: p.level.yellow },
    { label: '断连（>15min）', n: dead, color: p.level.red },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 7 }}>
      {/* 三段占比条：不用饼图，饼图读不出「差一点点就到临界」 */}
      <div style={{ display: 'flex', height: 14, borderRadius: 3, overflow: 'hidden', background: p.panelLine }}>
        {slots.map((s) =>
          s.n ? <span key={s.label} title={`${s.label} ${s.n}`} style={{ width: `${(s.n / total) * 100}%`, background: s.color, opacity: 0.85 }} /> : null,
        )}
      </div>
      <div style={{ display: 'flex', gap: 12, fontSize: 9.5, color: p.textDim, flexWrap: 'wrap' }}>
        {slots.map((s) => (
          <span key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, background: s.color, display: 'inline-block' }} />
            {s.label} <b style={{ color: p.text, fontVariantNumeric: 'tabular-nums' }}>{s.n}</b>
          </span>
        ))}
      </div>

      {/* 站点格阵：十个小方块，颜色＝上报延迟，一眼看出断的是哪几个 */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(5, total)}, 1fr)`, gap: 4, flex: '1 1 auto', minHeight: 0, alignContent: 'start' }}>
        {rows.map((r) => {
          const c = r.staleSec >= 900 ? p.level.red : r.staleSec >= 120 ? p.level.yellow : r.quality !== 'good' ? p.level.orange : p.level.blue
          const age = r.staleSec < 90 ? `${Math.round(r.staleSec)}s` : `${Math.round(r.staleSec / 60)}min`
          return (
            <div
              key={r.siteId}
              title={`${r.name}（${r.district}） · ${age}前更新 · 质量 ${r.quality}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 5px',
                borderRadius: 3,
                background: p.panelLine,
                borderLeft: `3px solid ${c}`,
                minWidth: 0,
              }}
            >
              <span style={{ fontSize: 9.5, fontVariantNumeric: 'tabular-nums', color: p.textDim, flex: '0 0 auto' }}>{r.siteId}</span>
              <span style={{ fontSize: 9, color: p.textFaint, marginLeft: 'auto', whiteSpace: 'nowrap' }}>{age}</span>
            </div>
          )
        })}
      </div>

      <div style={{ flex: '0 0 auto', display: 'flex', gap: 10, fontSize: 9, color: p.textFaint, borderTop: `1px solid ${p.panelLine}`, paddingTop: 4 }}>
        <span>
          引擎 <b style={{ color: health.engineOk ? p.levelInk.blue : p.levelInk.red }}>{health.engineOk ? '在线' : '掉线'}</b>
          <span style={{ marginLeft: 5 }}>已跑 {upMin}min · {health.engine.cycles} 轮</span>
        </span>
        <span>待结算 {health.engine.pending}</span>
        <span>质量异常 {suspect}</span>
        <span style={{ marginLeft: 'auto' }}>SSE {health.clients} 连接</span>
      </div>
    </div>
  )
}

/**
 * 告警处置效率：从「响了」到「确认了」到「结案了」各用了多久。
 *
 * 大屏上常见的是「新增告警数」，但那只是工作量；
 * 真正决定这套系统有没有用的是**响应时延**——响了一小时没人理，
 * 再准的模型也没意义。这块把三段时延分开画，因为瓶颈通常只在其中一段。
 */
export interface AlertLatencyRow {
  readonly raisedAt: number
  readonly ackedAt: number | null
  readonly clearedAt: number | null
  readonly level: Level
  readonly disposition: string
}

export function LatencyPanel({ rows, p }: { rows: readonly AlertLatencyRow[]; p: Palette }) {
  const ackD = rows.filter((r) => r.ackedAt != null).map((r) => (r.ackedAt as number) - r.raisedAt).filter((d) => d >= 0)
  const closeD = rows
    .filter((r) => r.clearedAt != null && r.ackedAt != null)
    .map((r) => (r.clearedAt as number) - (r.ackedAt as number))
    .filter((d) => d >= 0)

  const med = (arr: number[]) => {
    if (!arr.length) return null
    const s = [...arr].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }
  const maxV = (arr: number[]) => (arr.length ? Math.max(...arr) : 0)

  const m = (sec: number | null) => {
    if (sec == null) return '—'
    if (sec < 90) return `${Math.round(sec)}s`
    if (sec < 5400) return `${(sec / 60).toFixed(0)}min`
    return `${(sec / 3600).toFixed(1)}h`
  }

  const open = rows.filter((r) => r.disposition === 'open').length
  const handled = rows.filter((r) => r.disposition !== 'open').length
  const rate = rows.length ? (handled / rows.length) * 100 : 0

  // 直方图：把确认时延按「<1min / 1-5min / 5-30min / >30min」分桶
  const buckets = [0, 0, 0, 0]
  for (const d of ackD) {
    if (d < 60) buckets[0] += 1
    else if (d < 300) buckets[1] += 1
    else if (d < 1800) buckets[2] += 1
    else buckets[3] += 1
  }
  const bMax = Math.max(...buckets, 1)
  const bLabel = ['<1min', '1~5min', '5~30min', '>30min']
  const bColor = [p.level.blue, p.level.yellow, p.level.orange, p.level.red]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 6 }}>
      <div style={{ display: 'flex', gap: 14 }}>
        <Kpi label="确认中位时延" value={m(med(ackD))} hint={`${ackD.length}/${rows.length} 条已确认`} p={p} />
        <Kpi label="处置中位时延" value={m(med(closeD))} hint={`${closeD.length} 条已结案`} p={p} />
        <Kpi label="已接手占比" value={`${rate.toFixed(0)}%`} hint={`${open} 条仍待处理`} p={p} />
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'flex-end', gap: 8, paddingTop: 2 }}>
        {buckets.map((n, i) => (
          <div key={bLabel[i]} style={{ flex: '1 1 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, minWidth: 0 }}>
            <span style={{ fontSize: 10, color: n ? p.text : p.textFaint, fontVariantNumeric: 'tabular-nums' }}>{n}</span>
            <span
              style={{
                width: '100%',
                height: `${Math.max(2, (n / bMax) * 100)}%`,
                minHeight: 2,
                background: bColor[i],
                opacity: n ? 0.82 : 0.22,
                borderRadius: '2px 2px 0 0',
              }}
            />
            <span style={{ fontSize: 8.5, color: p.textFaint, whiteSpace: 'nowrap' }}>{bLabel[i]}</span>
          </div>
        ))}
      </div>

      <div style={{ flex: '0 0 auto', fontSize: 9, color: p.textFaint, borderTop: `1px solid ${p.panelLine}`, paddingTop: 4 }}>
        最长确认时延 {m(maxV(ackD))} · 共 {rows.length} 条预警记录 · 柱高＝该档条数
      </div>
    </div>
  )
}

function Kpi({ label, value, hint, p }: { label: string; value: string; hint: string; p: Palette }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      <span style={{ fontSize: 9, color: p.textFaint, letterSpacing: 0.3 }}>{label}</span>
      <b style={{ fontSize: 19, color: p.forecast, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums' }}>{value}</b>
      <span style={{ fontSize: 8.5, color: p.textFaint, whiteSpace: 'nowrap' }}>{hint}</span>
    </div>
  )
}

/**
 * 通知投递：推了多少条、成功率多少、卡在哪个渠道。
 *
 * 「发了但没送到」是运维最难发现的一类故障——后端日志是 200，
 * 接收方什么都没收到。把成功/失败按渠道摊开，比一个总成功率有用。
 */
export function DeliveryPanel({ rows, p }: { rows: readonly Delivery[]; p: Palette }) {
  if (!rows.length) return <div style={{ fontSize: 11, color: p.textFaint }}>等待投递记录</div>

  const byChannel = new Map<string, { ok: number; fail: number }>()
  for (const d of rows) {
    const c = byChannel.get(d.channel) ?? { ok: 0, fail: 0 }
    if (d.ok) c.ok += 1
    else c.fail += 1
    byChannel.set(d.channel, c)
  }
  const list = Array.from(byChannel.entries()).sort((a, b) => b[1].ok + b[1].fail - (a[1].ok + a[1].fail))
  const total = rows.length
  const okN = rows.filter((d) => d.ok).length
  const maxN = Math.max(...list.map(([, v]) => v.ok + v.fail), 1)
  const failN = total - okN

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <b style={{ fontSize: 22, color: p.text, fontVariantNumeric: 'tabular-nums' }}>{total}</b>
        <span style={{ fontSize: 9.5, color: p.textFaint }}>条投递</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: okN === total ? p.levelInk.blue : p.levelInk.orange, fontVariantNumeric: 'tabular-nums' }}>
          成功 {(okN / total * 100).toFixed(0)}%
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 3, overflow: 'hidden' }}>
        {list.slice(0, 6).map(([ch, v]) => {
          const n = v.ok + v.fail
          return (
            <div key={ch} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9.5, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ flex: '0 0 52px', color: p.textDim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ch}</span>
              <span style={{ flex: '1 1 auto', height: 9, background: p.panelLine, borderRadius: 2, overflow: 'hidden', display: 'flex' }}>
                <span style={{ width: `${(v.ok / maxN) * 100}%`, background: p.accent, opacity: 0.8 }} />
                <span style={{ width: `${(v.fail / maxN) * 100}%`, background: p.level.red, opacity: 0.85 }} />
              </span>
              <span style={{ flex: '0 0 30px', textAlign: 'right', color: p.textFaint }}>{n}</span>
              <span style={{ flex: '0 0 34px', textAlign: 'right', color: v.fail ? p.levelInk.red : p.textFaint }}>{v.fail ? `${v.fail}失败` : '全成功'}</span>
            </div>
          )
        })}
      </div>

      <div style={{ flex: '0 0 auto', fontSize: 9, color: p.textFaint, borderTop: `1px solid ${p.panelLine}`, paddingTop: 4 }}>
        {failN ? <span style={{ color: p.levelInk.orange }}>{failN} 条未送达，检查渠道配置</span> : <span>全部投递成功 · 蓝＝成功 红＝失败</span>}
      </div>
    </div>
  )
}

/**
 * 操作审计：谁在动配置。
 *
 * 大屏放审计流水不是为了「展示日志」，而是因为一张只读的大屏如果没有人操作过，
 * 说明它其实没被纳入流程。这块给最近几条写操作，能看出有没有人真的在用它。
 */
export function AuditFeed({ rows, p }: { rows: readonly AuditEntry[]; p: Palette }) {
  if (!rows.length) return <div style={{ fontSize: 11, color: p.textFaint }}>近 24h 无写操作</div>

  const byUser = new Map<string, number>()
  for (const r of rows) byUser.set(r.username, (byUser.get(r.username) ?? 0) + 1)
  const users = Array.from(byUser.entries()).sort((a, b) => b[1] - a[1])
  const failN = rows.filter((r) => r.status >= 400).length

  const hhmm = (simTime: number) => {
    // 仿真实时钟不等于墙钟，这里只能显示相对时间（「x 分钟前」），
    // 直接格式化会显示出 2030 年之类的假日期，比不显示更糟。
    const now = rows[0]?.at ?? simTime
    const d = Math.max(0, now - simTime)
    if (d < 60) return '刚刚'
    if (d < 3600) return `${Math.round(d / 60)}min`
    return `${(d / 3600).toFixed(1)}h`
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 5 }}>
      <div style={{ display: 'flex', gap: 10, fontSize: 9.5, color: p.textDim, flex: '0 0 auto' }}>
        <span>
          <b style={{ color: p.text, fontVariantNumeric: 'tabular-nums' }}>{rows.length}</b> 次写操作
        </span>
        <span>
          <b style={{ color: p.text, fontVariantNumeric: 'tabular-nums' }}>{users.length}</b> 人参与
        </span>
        <span style={{ color: failN ? p.levelInk.orange : p.textFaint }}>失败 {failN}</span>
        <span style={{ marginLeft: 'auto', color: p.textFaint }}>近 24 小时</span>
      </div>

      {/* 条目按可用高度均分：固定 8 行在 330 高的卡里只占上面一小条，
          下面一大片空着（截图里就是这个现象）。用 flex:1 1 0 让每行自己长高，
          条目少的时候也不会散架——行高有 minHeight 兜底。 */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' }}>
        {rows.slice(0, 12).map((r) => (
          <div key={r.id} style={{ flex: '1 1 0', minHeight: 16, display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, minWidth: 0, borderBottom: `1px solid ${p.panelLine}` }}>
            <span style={{ flex: '0 0 auto', color: p.textFaint, fontVariantNumeric: 'tabular-nums' }}>{hhmm(r.at)}</span>
            <span style={{ flex: '0 0 auto', color: p.accent2, fontSize: 9 }}>{r.username}</span>
            <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: r.status >= 400 ? p.levelInk.red : p.textDim }} title={`${r.method} ${r.path}`}>
              {r.summary}
            </span>
            <span style={{ flex: '0 0 auto', marginLeft: 'auto', color: r.status >= 400 ? p.levelInk.red : p.textFaint, fontVariantNumeric: 'tabular-nums' }}>{r.status}</span>
          </div>
        ))}
      </div>

      <div style={{ flex: '0 0 auto', display: 'flex', gap: 8, fontSize: 9, color: p.textFaint, borderTop: `1px solid ${p.panelLine}`, paddingTop: 4 }}>
        {users.slice(0, 4).map(([u, n]) => (
          <span key={u}>
            {u} <b style={{ color: p.textDim }}>{n}</b>
          </span>
        ))}
        <span style={{ marginLeft: 'auto' }}>只记写操作</span>
      </div>
    </div>
  )
}

/**
 * 模型版本轨迹：这台机器换过几次脑子、每次换完是不是更好。
 *
 * 3h skill 是关键指标：模型换代如果 skill 没上去，那只是「版本号变了」。
 * 用折线连起来，一眼能看出这次换版是在爬还是掉。
 */
export function VersionTrack({ versions, active, p }: { versions: readonly ModelVersion[]; active: string; p: Palette }) {
  if (!versions.length) return <div style={{ fontSize: 11, color: p.textFaint }}>暂无版本记录</div>

  const withSkill = versions.filter((v) => v.skill3h != null).slice(0, 10).reverse()
  const vals = withSkill.map((v) => v.skill3h as number)
  const hi = Math.max(...vals, 0.1)
  // 零线必须留（skill=0 是「不如不预测」的临界），但不能让它把数据带压扁：
  // 六个版本都落在 0.4~0.53，若 y 轴严格按 [0, hi] 铺满，曲线只占顶部一小条。
  // 折中——纵向范围取 [min(0, lo-0.05), hi+0.05]，零线仍然画，但数据占主要高度。
  const lo = Math.min(0, ...vals) - 0.04
  const span = Math.max(0.02, hi - lo)

  const W = 100
  const H = 26
  const xOf = (i: number) => (withSkill.length <= 1 ? W / 2 : 4 + (i / (withSkill.length - 1)) * (W - 8))
  const yOf = (v: number) => H - 2 - ((v - lo) / span) * (H - 4)
  const d = withSkill.map((v, i) => `${i ? 'L' : 'M'}${xOf(i).toFixed(2)},${yOf(v.skill3h as number).toFixed(2)}`).join(' ')

  const cur = versions.find((v) => v.active)
  const best = withSkill.reduce<ModelVersion | null>((a, v) => (!a || (v.skill3h as number) > (a.skill3h as number) ? v : a), null)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 4 }}>
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
          <line x1={0} y1={yOf(0)} x2={W} y2={yOf(0)} stroke={p.panelLine} strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray="2 2" />
          {withSkill.length > 1 && (
            <path d={d} fill="none" stroke={p.forecast} strokeWidth={1.4} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          )}
          {withSkill.map((v, i) => (
            <circle
              key={v.version}
              cx={xOf(i)}
              cy={yOf(v.skill3h as number)}
              r={v.active ? 1.9 : 1.1}
              fill={v.active ? p.accent : p.forecast}
              opacity={v.active ? 1 : 0.7}
            />
          ))}
        </svg>
      </div>
      <div style={{ display: 'flex', gap: 10, fontSize: 9.5, color: p.textDim, flexWrap: 'wrap', flex: '0 0 auto' }}>
        <span>
          共 <b style={{ color: p.text }}>{versions.length}</b> 版
        </span>
        <span>
          当前 3h skill <b style={{ color: p.text, fontVariantNumeric: 'tabular-nums' }}>{(cur?.skill3h ?? 0).toFixed(2)}</b>
        </span>
        {best && (
          <span style={{ color: p.textFaint }}>
            最佳 {best.version.slice(-8)} · {(best.skill3h as number).toFixed(2)}
          </span>
        )}
      </div>
      <div style={{ flex: '0 0 auto', fontSize: 9, color: p.textFaint, borderTop: `1px solid ${p.panelLine}`, paddingTop: 3 }}>
        生效版本 <b style={{ color: p.textDim }}>{active}</b>
        {cur?.rmse3h != null && <span> · 3h RMSE {Number(cur.rmse3h).toFixed(3)}m</span>}
        {cur?.trainSeconds != null && <span> · 训练 {Math.round(cur.trainSeconds)}s</span>}
      </div>
    </div>
  )
}
