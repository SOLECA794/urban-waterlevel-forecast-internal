import { useMemo } from 'react'
import type {
  AlertEvent,
  Forecast,
  Level,
  Meters,
  SimTime,
  SiteForecast,
  SiteSeries,
  Thresholds,
} from '../domain'
import type { OverviewRow } from '../data/queries'
import {
  ALARM_LEVELS,
  LEVEL_LABEL,
  LEVEL_ORDER,
  LEVEL_RANK,
  curveDepth,
  depthOf,
  fmtMinutes,
  fmtTime,
  horizonOf,
  isAlarm,
  maxLevel,
  redThreshold,
  thresholdOf,
} from '../domain'
import { useMapPoints, type MapPoint } from '../view/useMapPoints'
import { usePalette } from './theme'
import { BarRow, BigStat, CountUp, Donut, LevelTag, Panel } from './parts'

/**
 * 四个「数据类别」场景。
 *
 * 轮换的分界不是「页面」，而是**数据类别**：态势（等级/地理）、预测（未来）、
 * 对比（同类之间）、过程（单点时间序列）。轮换一圈，观众看到的是同一座城市的
 * 四种切片，而不是四张互不相干的报表。
 *
 * 每个场景只用一类主数据：大屏没人会停下手里的活去读第二行小字。
 */

// ------------------------------------------------------------------ 场景一：态势

export function SceneOverview({
  rows,
  alerts,
}: {
  rows: readonly OverviewRow[]
  alerts: readonly AlertEvent[]
}) {
  const p = usePalette()
  const points = useMapPoints()

  const counts = LEVEL_ORDER.map((lv) => ({
    level: lv,
    value: rows.filter((r) => r.assessment.level === lv).length,
  }))
  const alarmCount = rows.filter((r) => isAlarm(r.assessment.level)).length
  const deepest = rows.reduce((a, r) => Math.max(a, Math.max(0, r.reading.depth)), 0)
  const raining = rows.filter((r) => r.reading.rain >= 1).length
  const longest = rows.reduce((a, r) => Math.max(a, r.assessment.durationMin), 0)
  const longestSite = rows.find((r) => r.assessment.durationMin === longest)?.site.name ?? '—'
  const worst = maxLevel(rows.map((r) => r.assessment.level))

  // 24 小时 × 12 格（每 2 小时一格），格内取最高等级
  const now = rows[0]?.reading.updatedAt ?? (0 as SimTime)
  const slots = useMemo(() => {
    const out: { level: Level; n: number }[] = []
    for (let i = 22; i >= 0; i -= 2) {
      const from = now - (i + 2) * 3600
      const to = now - i * 3600
      const hit = alerts.filter((a) => a.raisedAt >= from && a.raisedAt < to)
      out.push({ level: maxLevel(hit.map((a) => a.level)), n: hit.length })
    }
    return out
  }, [alerts, now])

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '300px 1fr 300px',
        gridTemplateRows: '1fr',
        gap: 14,
        height: '100%',
      }}
    >
      <Panel
        title="当前态势"
        sub={`${rows.length} 个监测点`}
        bodyStyle={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            gap: 18,
            paddingTop: 6,
          }}
        >
          <BigStat
            label="报警站点"
            value={alarmCount}
            unit={`/ ${rows.length}`}
            color={p.level[worst]}
            foot={`最高等级 ${LEVEL_LABEL[worst]}`}
          />
          <BigStat label="最深积水" value={deepest} digits={2} unit="m" size={44} foot="取单站最深，不是全城相加" />
          <div style={{ display: 'flex', gap: 26 }}>
            <BigStat label="降雨中" value={raining} unit="站" size={30} />
            <BigStat
              label="24h 告警"
              value={alerts.filter((a) => a.raisedAt >= now - 24 * 3600).length}
              unit="次"
              size={30}
              foot={alerts.length >= 100 ? '列表上限 100 条' : undefined}
            />
          </div>
          <BigStat
            label="持续最久"
            value={longest}
            unit="min"
            foot={`${longestSite} 已连续超阈`}
            size={34}
          />
        </div>
      </Panel>

      <Panel title="全城积水分布" sub="气泡大小按积水深 · 颜色按研判等级">
        <MapBoard points={points} />
      </Panel>

      <Panel
        title="等级构成"
        bodyStyle={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, paddingTop: 2 }}>
          <Donut data={counts} center={<CountUp value={alarmCount} />} centerSub="报警站点" size={172} />
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {LEVEL_ORDER.map((lv) => (
              <div key={lv} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: p.level[lv] }} />
                <span style={{ color: p.textDim }}>{LEVEL_LABEL[lv]}</span>
                <span
                  style={{ marginLeft: 'auto', color: p.text, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
                >
                  {counts.find((c) => c.level === lv)?.value ?? 0}
                </span>
              </div>
            ))}
          </div>
          <div style={{ width: '100%', paddingTop: 4 }}>
            <div style={{ fontSize: 11, color: p.textFaint, marginBottom: 4, letterSpacing: 1 }}>近 24 小时告警密度</div>
            <div style={{ display: 'flex', gap: 2 }}>
              {slots.map((s, i) => (
                <span
                  key={i}
                  style={{
                    flex: 1,
                    height: 22,
                    borderRadius: 2,
                    background: s.n === 0 ? p.levelSoft.none : p.level[s.level],
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </Panel>
    </div>
  )
}

export function MapBoard({
  points,
  activeId,
  compact,
  width = 1000,
  height = 560,
}: {
  points: readonly MapPoint[]
  activeId?: string
  compact?: boolean
  /** 画布宽度：大屏按容器像素传入，画布比例与容器一致，才不会出现留白。 */
  width?: number
  height?: number
}) {
  const p = usePalette()
  const W = width
  const H = height
  const ink = '#FFFFFF'

  // 站点名比气泡宽得多，同一片区的两个站会叠成一团。做一次矩形避让：
  // 被气泡或已放置的标签挡住就往下挪一行，最多 8 次。
  const labels = useMemo(() => {
    const circles = points.map((q) => ({
      x1: q.x - q.radius - 2,
      x2: q.x + q.radius + 2,
      y1: q.y - q.radius - 22,
      y2: q.y + q.radius + 2,
    }))
    const placed: { x1: number; x2: number; y: number }[] = []
    return points.map((pt) => {
      const w = pt.name.length * (compact ? 8.8 : 13.5)
      const x1 = pt.x - w / 2
      const x2 = pt.x + w / 2
      let y = pt.y + pt.radius + (compact ? 13 : 18)
      for (let k = 0; k < 8; k += 1) {
        const hitLabel = placed.some((q) => !(x2 < q.x1 || x1 > q.x2) && Math.abs(y - q.y) < 12)
        const hitCircle = circles.some((c) => !(x2 < c.x1 || x1 > c.x2) && y + 6 > c.y1 && y - 13 < c.y2)
        if (!hitLabel && !hitCircle) break
        y += compact ? 12 : 17
      }
      placed.push({ x1, x2, y })
      return y
    })
  }, [points, compact])

  const fs = compact ? 6.2 : 13
  const ds = compact ? 6.8 : 13

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: '100%' }} preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="mbLand" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F7FAFD" />
          <stop offset="52%" stopColor="#FCFDFF" />
          <stop offset="100%" stopColor="#F2F7FB" />
        </linearGradient>
        <linearGradient id="mbHill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#E8F0F8" />
          <stop offset="100%" stopColor="#F3F8FC" />
        </linearGradient>
        <linearGradient id="mbWater" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#D7E9F8" />
          <stop offset="100%" stopColor="#C2DBF0" />
        </linearGradient>
        <pattern id="mbBlocks" width="27" height="27" patternUnits="userSpaceOnUse" patternTransform="rotate(11)">
          <rect x="1.5" y="1.5" width="24" height="24" rx="1.5" fill="#F7FAFD" stroke="#E7EEF6" strokeWidth="0.7" />
        </pattern>
        <radialGradient id="mbGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* 土地 + 街坊肌理：只画网格会像坐标纸，加一层旋转 11° 的街坊才像中国城市 */}
      <rect width={W} height={H} fill="url(#mbLand)" />
      <rect width={W} height={H} fill="url(#mbBlocks)" opacity={0.6} />

      {/* 北侧山地（黄岩西、北靠山） */}
      <path
        d={`M0 0 H${W} V104 C ${W * 0.86} 82, ${W * 0.72} 116, ${W * 0.6} 96 C ${W * 0.48} 76, ${W * 0.34} 118, ${W * 0.22} 96 C ${W * 0.12} 78, ${W * 0.05} 96, 0 84 Z`}
        fill="url(#mbHill)"
      />
      <path
        d={`M0 0 H${W} V56 C ${W * 0.84} 42, ${W * 0.68} 68, ${W * 0.54} 52 C ${W * 0.4} 36, ${W * 0.28} 62, ${W * 0.16} 48 C ${W * 0.08} 40, ${W * 0.03} 48, 0 42 Z`}
        fill="#DFE9F3"
        opacity={0.6}
      />

      {/* 绿地公园 */}
      {[
        [150, 196, 74, 42],
        [420, 150, 96, 48],
        [706, 210, 82, 40],
        [244, 392, 70, 38],
        [612, 424, 90, 44],
      ].map(([x, y, rx, ry], i) => (
        <ellipse key={`p${i}`} cx={x} cy={y} rx={rx} ry={ry} fill="#EAF1E9" opacity={0.7} />
      ))}

      {/* 永宁江：一条斜贯全城的主河道 + 两条支流 */}
      <path
        d={`M-30 ${H * 0.62} C ${W * 0.16} ${H * 0.52}, ${W * 0.28} ${H * 0.76}, ${W * 0.44} ${H * 0.68} S ${W * 0.7} ${H * 0.56}, ${W * 0.84} ${H * 0.66} S ${W * 1.02} ${H * 0.7}, ${W + 30} ${H * 0.66}`}
        fill="none"
        stroke="url(#mbWater)"
        strokeWidth={24}
        strokeLinecap="round"
      />
      <path
        d={`M-30 ${H * 0.62} C ${W * 0.16} ${H * 0.52}, ${W * 0.28} ${H * 0.76}, ${W * 0.44} ${H * 0.68} S ${W * 0.7} ${H * 0.56}, ${W * 0.84} ${H * 0.66} S ${W * 1.02} ${H * 0.7}, ${W + 30} ${H * 0.66}`}
        fill="none"
        stroke="#FFFFFF"
        strokeWidth={5}
        opacity={0.55}
        strokeLinecap="round"
      />
      <path
        d={`M ${W * 0.3} ${H * 0.68} C ${W * 0.34} ${H * 0.84}, ${W * 0.3} ${H * 0.92}, ${W * 0.36} ${H + 20}`}
        fill="none"
        stroke="url(#mbWater)"
        strokeWidth={9}
        strokeLinecap="round"
        opacity={0.9}
      />
      <path
        d={`M ${W * 0.68} ${H * 0.6} C ${W * 0.72} ${H * 0.44}, ${W * 0.66} ${H * 0.34}, ${W * 0.7} ${H * 0.2}`}
        fill="none"
        stroke="url(#mbWater)"
        strokeWidth={7}
        strokeLinecap="round"
        opacity={0.85}
      />

      {/* 主干道：白色宽带压在水面之上，像地图里的高架 */}
      {[
        `M-40 ${H * 0.4} C ${W * 0.22} ${H * 0.34}, ${W * 0.44} ${H * 0.44}, ${W * 0.66} ${H * 0.38} S ${W * 0.94} ${H * 0.44}, ${W + 40} ${H * 0.36}`,
        `M ${W * 0.46} -20 C ${W * 0.5} ${H * 0.24}, ${W * 0.44} ${H * 0.5}, ${W * 0.52} ${H * 0.78} S ${W * 0.5} ${H * 1.1}, ${W * 0.54} ${H + 40}`,
        `M-40 ${H * 0.84} C ${W * 0.3} ${H * 0.78}, ${W * 0.62} ${H * 0.9}, ${W + 40} ${H * 0.82}`,
      ].map((d, i) => (
        <g key={`r${i}`}>
          <path d={d} fill="none" stroke="#FFFFFF" strokeWidth={9} opacity={0.92} strokeLinecap="round" />
          <path d={d} fill="none" stroke={p.accent} strokeWidth={1.2} opacity={0.26} strokeLinecap="round" strokeDasharray="9 13" />
        </g>
      ))}

      {/* 支路网：主路之外的毛细血管。没有这一层，地图看起来像几块草地上的三条白线。 */}
      <g opacity={0.55}>
        {[0.16, 0.3, 0.44, 0.58, 0.72, 0.86].map((t, i) => (
          <line key={`sh${i}`} x1={-20} y1={H * t} x2={W + 20} y2={H * (t + 0.03)} stroke="#FFFFFF" strokeWidth={2.6} />
        ))}
        {[0.12, 0.26, 0.4, 0.54, 0.68, 0.82, 0.94].map((t, i) => (
          <line key={`sv${i}`} x1={W * t} y1={-20} x2={W * (t - 0.02)} y2={H + 20} stroke="#FFFFFF" strokeWidth={2.6} />
        ))}
      </g>

      {/* 建筑组团：几片密排小方块，模拟老城区的肌理 */}
      <g opacity={0.5}>
        {[
          [300, 250, 9, 6],
          [520, 300, 8, 5],
          [700, 340, 10, 6],
          [380, 470, 8, 5],
        ].map(([ox, oy, cols, rows], gi) =>
          Array.from({ length: cols * rows }, (_, k) => {
            const cx = (ox as number) + ((k % (cols as number)) * 9)
            const cy = (oy as number) + (Math.floor(k / (cols as number)) * 9)
            return <rect key={`b${gi}-${k}`} x={cx} y={cy} width={7} height={7} rx={1} fill="#E1E9F2" />
          }),
        )}
      </g>

      {/* 水库与池塘：黄岩有长潭水库，城市里也有几处调蓄水面 */}
      <ellipse cx={W * 0.86} cy={H * 0.24} rx={54} ry={30} fill="#CFE3F5" opacity={0.95} />
      <ellipse cx={W * 0.86} cy={H * 0.24} rx={54} ry={30} fill="none" stroke="#FFFFFF" strokeWidth={2} opacity={0.7} />
      <ellipse cx={W * 0.2} cy={H * 0.78} rx={38} ry={22} fill="#D8E9F8" opacity={0.9} />

      {/* 行政区界：虚线，给平面一个「有管辖范围」的暗示 */}
      <path
        d={`M ${W * 0.2} ${H * 0.12} L ${W * 0.34} ${H * 0.34} L ${W * 0.28} ${H * 0.58} L ${W * 0.42} ${H * 0.9}`}
        fill="none"
        stroke="#9DB28C"
        strokeWidth={1.6}
        strokeDasharray="7 7"
        opacity={0.55}
      />
      <path
        d={`M ${W * 0.62} ${H * 0.1} L ${W * 0.72} ${H * 0.32} L ${W * 0.66} ${H * 0.56} L ${W * 0.78} ${H * 0.88}`}
        fill="none"
        stroke="#8FAE7C"
        strokeWidth={1.6}
        strokeDasharray="7 7"
        opacity={0.55}
      />

      {/* 片区名：只作地理参照，不承载数据 */}
      {[
        ['西城街道', 0.2, 0.46],
        ['东城街道', 0.46, 0.3],
        ['北城街道', 0.62, 0.16],
        ['新前街道', 0.1, 0.24],
        ['南城街道', 0.5, 0.86],
      ].map(([name, x, y]) => (
        <text
          key={name as string}
          x={(x as number) * W}
          y={(y as number) * H}
          textAnchor="middle"
          fontSize={compact ? 9 : 13}
          fill="#8EA37F"
          opacity={0.6}
          letterSpacing={2}
        >
          {name as string}
        </text>
      ))}

      {/* 站点 */}
      {points.map((pt, idx) => {
        const color = p.level[pt.level]
        return (
          <g key={pt.siteId}>
            {activeId === pt.siteId && (
              <>
                <circle cx={pt.x} cy={pt.y} r={pt.radius * 3.4} fill="url(#mbGlow)" opacity={0.85} />
                <circle cx={pt.x} cy={pt.y} r={pt.radius + 16} fill="none" stroke={color} strokeWidth={2.6}>
                  <animate attributeName="r" values={`${pt.radius + 12};${pt.radius + 26};${pt.radius + 12}`} dur="2.6s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.95;0.1;0.95" dur="2.6s" repeatCount="indefinite" />
                </circle>
              </>
            )}
            {pt.isAlarm && (
              <circle cx={pt.x} cy={pt.y} r={pt.radius + 12} fill={color} opacity={0.24}>
                <animate attributeName="r" values={`${pt.radius + 5};${pt.radius + 22}`} dur="2.4s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.3;0" dur="2.4s" repeatCount="indefinite" />
              </circle>
            )}
            <circle cx={pt.x} cy={pt.y} r={pt.radius + 1.6} fill="#FFFFFF" opacity={0.95} />
            <circle cx={pt.x} cy={pt.y} r={pt.radius} fill={color} />
            <text
              x={pt.x}
              y={labels[idx]}
              textAnchor="middle"
              fontSize={fs}
              fill="#12303F"
              stroke={ink}
              strokeWidth={compact ? 2.2 : 3}
              paintOrder="stroke"
              style={{ fontWeight: 700 }}
            >
              {pt.name}
            </text>
            {pt.depth > 0.02 && (
              <text
                x={pt.x}
                y={pt.y - pt.radius - (compact ? 5 : 9)}
                textAnchor="middle"
                fontSize={ds}
                fill={p.levelInk[pt.level]}
                stroke={ink}
                strokeWidth={compact ? 2.2 : 3}
                paintOrder="stroke"
                style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}
              >
                {pt.depth.toFixed(2)}m
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

// ------------------------------------------------------------------ 场景二：预测

export function SceneForecast({
  rows,
  forecast,
}: {
  rows: readonly OverviewRow[]
  forecast: Forecast | null
}) {
  const p = usePalette()

  // ⚠ 这一屏只用 forecast 这一份快照。
  //    早先混用了 overview 的 assessment（30s 刷）和 forecast 的曲线（60s 刷），
  //    两代快照拼在一起会出现「峰值 1.36m 却显示无预警」这种自相矛盾的画面。
  //    现在峰值/时刻/等级全部取自同一份 payload 里的 sf.assessment 与 sf.curve。
  const items = useMemo(
    () =>
      rows
        .map((r) => {
          const sf = forecast?.sites[r.site.id] ?? null
          if (!sf) return null
          const depths = curveDepth(sf.curve, r.site.baseLevel).map((d) => Math.max(0, d))
          const nowDepth = Math.max(0, sf.nowLevel - r.site.baseLevel)
          const peak = Math.max(0, sf.assessment.peakValue, nowDepth, ...depths)
          // 量程必须包住「现在」与「峰值」：只按红阈算，水深一旦超过红阈，
          // 整条曲线会被裁在轨道顶端拉成一条直线，那样这一屏什么也没说。
          const max = Math.max(redThreshold(r.site.thresholds) * 1.55, peak * 1.12, 0.12)
          return { r, sf, depths, nowDepth, peak, max }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort(
          (a, b) =>
            LEVEL_RANK[b.sf.assessment.level] - LEVEL_RANK[a.sf.assessment.level] || b.peak - a.peak,
        ),
    [rows, forecast],
  )

  return (
    <Panel
      title="12 小时预测越阈"
      sub="每站一条预测曲线 · 底色为该站四级阈值横带 · 全部取自同一份预测快照"
      right={<span style={{ fontSize: 12, color: p.textFaint }}>按等级与峰值排序</span>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, height: '100%' }}>
        <div style={{ display: 'flex', gap: 10, fontSize: 11, color: p.textFaint, paddingLeft: 132 }}>
          <span style={{ flex: 1, display: 'flex', justifyContent: 'space-between' }}>
            <span>现在</span>
            <span>+3h</span>
            <span>+6h</span>
            <span>+9h</span>
            <span>+12h</span>
          </span>
          <span style={{ width: 78, textAlign: 'right' }}>峰值</span>
          <span style={{ width: 62, textAlign: 'right' }}>时刻</span>
          <span style={{ width: 82 }} />
        </div>
        {items.map(({ r, sf, depths, nowDepth, peak, max }) => {
          const W = 100
          const H = 26
          const x = (i: number) => (i / Math.max(1, depths.length - 1)) * W
          // 留 1.5px 底边距：干燥期 d≈0，曲线会正好压在轨道下边框上，看起来像断了
          const y = (d: number) => H - 1.5 - (Math.min(d, max) / max) * (H - 4)
          const path =
            depths.length > 1
              ? depths.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(d).toFixed(2)}`).join(' ')
              : ''
          const pi = depths.reduce((b, d, i) => (d > (depths[b] ?? 0) ? i : b), 0)
          const t = r.site.thresholds
          const red = redThreshold(t)
          const at = (d: number) => Math.min(100, Math.max(0, (y(d) / H) * 100)).toFixed(1)
          const noneAt = at(t.blue)
          const lvl = sf.assessment.level
          return (
            <div key={r.site.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minHeight: 0 }}>
              <div style={{ width: 122, flexShrink: 0 }}>
                <div
                  style={{
                    fontSize: 13.5,
                    color: p.text,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {r.site.name}
                </div>
                <div style={{ fontSize: 11, color: p.textFaint, fontVariantNumeric: 'tabular-nums' }}>
                  {r.site.id} · 现在 {nowDepth.toFixed(2)}m
                </div>
              </div>
              <div style={{ position: 'relative', flex: 1, height: H }}>
                <span
                  style={{
                    position: 'absolute',
                    inset: 0,
                    borderRadius: 2,
                    background:
                      'linear-gradient(180deg,' +
                      `${p.levelSoft.red} 0% ${at(red)}%,` +
                      `${p.levelSoft.orange} ${at(red)}% ${at(t.orange)}%,` +
                      `${p.levelSoft.yellow} ${at(t.orange)}% ${at(t.yellow)}%,` +
                      `${p.levelSoft.blue} ${at(t.yellow)}% ${noneAt}%,` +
                      `${p.levelSoft.none} ${noneAt}% 100%)`,
                  }}
                />
                <span
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: y(red),
                    height: 1,
                    background: `${p.level.red}99`,
                  }}
                />
                {depths.length > 1 && (
                  <svg
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                    viewBox={`0 0 ${W} ${H}`}
                    preserveAspectRatio="none"
                  >
                    <path
                      d={path}
                      fill="none"
                      stroke={p.forecast}
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                      strokeLinejoin="round"
                    />
                    <circle cx={x(pi)} cy={y(depths[pi] ?? 0)} r={2.6} fill={p.forecast} />
                  </svg>
                )}
              </div>
              <span
                style={{
                  width: 78,
                  textAlign: 'right',
                  fontSize: 17,
                  fontWeight: 700,
                  color: p.levelInk[lvl],
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {peak.toFixed(2)}m
              </span>
              <span
                style={{
                  width: 62,
                  textAlign: 'right',
                  fontSize: 13,
                  color: p.textDim,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {sf.assessment.peakAtMin && sf.assessment.peakAtMin > 0
                  ? fmtMinutes(sf.assessment.peakAtMin)
                  : '即刻'}
              </span>
              <span style={{ width: 82 }}>
                <LevelTag level={lvl} />
              </span>
            </div>
          )
        })}
        {items.length === 0 && (
          <div style={{ color: p.textFaint, fontSize: 14, padding: 20 }}>尚无预测快照</div>
        )}
      </div>
    </Panel>
  )
}

// ------------------------------------------------------------------ 场景三：多类别对比

export function SceneCompare({ rows }: { rows: readonly OverviewRow[] }) {
  const p = usePalette()

  const camps = [
    {
      key: 'depth',
      title: '积水深',
      unit: 'm',
      color: p.accent2,
      value: (r: OverviewRow) => Math.max(0, r.reading.depth),
      fmt: (v: number) => v.toFixed(2),
    },
    {
      key: 'rain',
      title: '当前雨强',
      unit: 'mm/h',
      color: p.rain,
      value: (r: OverviewRow) => r.reading.rain,
      fmt: (v: number) => v.toFixed(1),
    },
    {
      key: 'trend',
      title: '1 小时涨速',
      unit: 'm/h',
      color: p.forecast,
      value: (r: OverviewRow) => r.reading.trend1h,
      fmt: (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`,
    },
  ]

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gridTemplateRows: '1fr',
        gap: 14,
        height: '100%',
      }}
    >
      {camps.map((c) => {
        const sorted = [...rows].sort((a, b) => c.value(b) - c.value(a)).slice(0, 8)
        const max = Math.max(...sorted.map((r) => c.value(r)), 0.001)
        return (
          // 面板 body 默认是 block，内层 div 的 flex:1 不生效，条形就只堆在顶部。
          <Panel
            key={c.key}
            title={c.title}
            sub={`单位 ${c.unit} · 取前十中的前 8`}
            bodyStyle={{ display: 'flex', flexDirection: 'column' }}
          >
            {/* 铺满高度：只堆在顶部会让整屏像没加载完 */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-evenly',
                flex: 1,
                minHeight: 0,
                paddingTop: 4,
              }}
            >
              {sorted.map((r, i) => (
                <BarRow
                  key={r.site.id}
                  label={`${i + 1}. ${r.site.name}`}
                  value={c.value(r)}
                  max={max}
                  color={c.key === 'trend' ? (c.value(r) >= 0 ? p.level.red : p.level.blue) : c.color}
                  right={c.fmt(c.value(r))}
                  height={26}
                />
              ))}
            </div>
          </Panel>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------------ 场景四：单站过程

export function SceneTrend({
  row,
  series,
  forecast,
  issuedAt,
}: {
  row: OverviewRow | null
  series: SiteSeries | null
  forecast: SiteForecast | null
  issuedAt: SimTime | null
}) {
  const p = usePalette()
  if (!row) {
    return (
      <Panel title="单站过程">
        <div style={{ color: p.textFaint, fontSize: 14 }}>暂无数据</div>
      </Panel>
    )
  }
  const { site, reading, assessment } = row

  // 曲线来自 /sites/{id}（30s 一份），「当前积水」若取 overview（另一份快照），
  // 涨水期两条线会对不上——0.62m 的数字配 0.30m 的线尾，看起来像数据坏了。
  // 所以这一屏的数字一律从 series 末点算，跟白线尾巴严丝合缝。
  const pts = series?.points ?? []
  const last = pts.length > 0 ? pts[pts.length - 1] : null
  const curDepth = last ? Math.max(0, depthOf(last.level, site.baseLevel)) : Math.max(0, reading.depth)
  const curRain = last ? last.rain : reading.rain
  const hourAgo = pts.length > 13 ? pts[pts.length - 13] : null
  const curTrend = hourAgo ? depthOf(last?.level ?? hourAgo.level, site.baseLevel) - depthOf(hourAgo.level, site.baseLevel) : reading.trend1h

  return (
    <Panel
      title={site.name}
      sub={`${site.id} · ${site.district} · 基准高程 ${site.baseLevel.toFixed(3)}m`}
      right={<LevelTag level={assessment.level} score={assessment.score} />}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 254px', gap: 16, height: '100%' }}>
        <TrendBoard
          series={series}
          forecast={forecast}
          issuedAt={issuedAt}
          thresholds={site.thresholds}
          baseLevel={site.baseLevel}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 2 }}>
          <BigStat label="当前积水" value={curDepth} digits={2} unit="m" color={p.level[assessment.level]} />
          <div style={{ display: 'flex', gap: 18 }}>
            <BigStat label="雨强" value={curRain} digits={1} unit="mm/h" size={26} />
            <BigStat label="1h 涨速" value={curTrend} digits={3} unit="m/h" size={26} />
          </div>
          <div
            style={{
              borderTop: `1px solid ${p.panelBorder}`,
              paddingTop: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 7,
            }}
          >
            <span style={{ fontSize: 11, color: p.textFaint, letterSpacing: 1 }}>四档预测（绝对水位 / 增量）</span>
            {[60, 180, 360, 720].map((h) => {
              const hz = horizonOf(forecast ?? undefined, h)
              return (
                <div key={h} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 }}>
                  <span style={{ width: 34, color: p.textDim }}>{h / 60}h</span>
                  <span style={{ color: p.text, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                    {hz ? hz.level.toFixed(3) : '—'}
                  </span>
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 12,
                      color: p.textFaint,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {hz ? `${hz.delta >= 0 ? '+' : ''}${hz.delta.toFixed(3)}` : ''}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </Panel>
  )
}

export function TrendBoard({
  series,
  forecast,
  issuedAt,
  thresholds,
  baseLevel,
  highlight = true,
}: {
  series: SiteSeries | null
  forecast: SiteForecast | null
  issuedAt: SimTime | null
  thresholds: Thresholds
  baseLevel: Meters
  /** 主视觉卡：线更粗、加雨量柱、加 90% 区间带、加当前值标注 */
  highlight?: boolean
}) {
  const p = usePalette()
  const W = 720
  const H = 330
  const padL = 38
  const padB = 30
  const padT = highlight ? 26 : 14
  const rainH = highlight ? 46 : 0

  const geo = useMemo(() => {
    // 历史给的是 24h，全画进来的话「现在」被挤到 2/3 处，未来只剩 1/3 宽。
    // 大屏关心的是接下来怎么走，所以历史裁到最近 12h，历史:未来 = 1:1。
    const hist = (series?.points ?? []).slice(-144)
    const obs = hist.map((pt) => ({
      at: pt.at,
      d: Math.max(0, depthOf(pt.level, baseLevel)),
      r: Number(pt.rain),
    }))
    const t0 = obs.length > 0 ? obs[0].at : 0
    const nowOff = obs.length > 0 ? obs[obs.length - 1].at - t0 : 0
    const obsPts = obs.map((o) => ({ x: o.at - t0, y: o.d }))
    const rainPts = obs.map((o) => ({ x: o.at - t0, r: o.r }))
    const fcPts =
      issuedAt === null
        ? []
        : (forecast?.curve ?? []).map((c) => ({
            x: issuedAt + c.offsetMin * 60 - t0,
            y: Math.max(0, c.level - baseLevel),
            lo: Math.max(0, c.lower - baseLevel),
            hi: Math.max(0, c.upper - baseLevel),
          }))
    const span = Math.max(nowOff + 720 * 60, nowOff, 1)
    return { obsPts, fcPts, rainPts, nowOff, span, t0, obs }
  }, [series, forecast, issuedAt, baseLevel])

  const red = redThreshold(thresholds)
  const maxD = Math.max(
    red * 1.25,
    ...geo.obsPts.map((o) => o.y),
    ...geo.fcPts.map((f) => f.hi),
    0.06,
  )
  const plotH = H - padB - padT - rainH
  const px = (x: number) => padL + (x / geo.span) * (W - padL - 12)
  const py = (d: number) => padT + plotH - (Math.min(d, maxD) / maxD) * plotH
  // gap 是「相邻采样落差超过这个值就断开」。
  // 演练用的「排空积水」会让水位在一格之内归零，直连会在图上画出一道垂直断崖，
  // 看起来像模型崩了；断开成两段，读者看到的是「这里有一次人工清零」。
  const line = (pts: { x: number; y: number }[], gap = 0) => {
    let d = ''
    let prev: number | null = null
    pts.forEach((pt, i) => {
      const jump = prev !== null && gap > 0 && Math.abs(pt.y - prev) > gap
      d += `${i === 0 || jump ? 'M' : 'L'}${px(pt.x).toFixed(1)},${py(pt.y).toFixed(1)}`
      prev = pt.y
    })
    return d
  }

  // 90% 区间：预测段画成一条带状（上下界折线闭合），大屏上「预测有多不确定」要看得见
  const bandPath = () => {
    const f = geo.fcPts
    if (f.length < 2) return ''
    const up = f.map((c, i) => `${i === 0 ? 'M' : 'L'}${px(c.x).toFixed(1)},${py(c.hi).toFixed(1)}`).join('')
    const dn = [...f].reverse().map((c) => `L${px(c.x).toFixed(1)},${py(c.lo).toFixed(1)}`).join('')
    return `${up}${dn}Z`
  }

  const cur = geo.obs.length ? geo.obs[geo.obs.length - 1] : null
  // obs 存的是绝对时刻 at，绘图坐标要减去起点再乘比例；直接取 cur.x 会拿到 undefined
  const curX = cur ? (cur.at - geo.t0) : 0
  const fcPeak = geo.fcPts.reduce((a, c) => (c.y > a.y ? c : a), { x: 0, y: 0, lo: 0, hi: 0 })
  const maxRain = Math.max(1, ...geo.rainPts.map((r) => r.r))
  const rainY = (r: number) => H - padB - (r / maxRain) * (rainH - 6)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
      {/* 未来段底色：一眼分出「哪一半是已经发生的、哪一半是还没发生的」 */}
      <rect
        x={px(geo.nowOff)}
        y={padT}
        width={Math.max(0, W - 12 - px(geo.nowOff))}
        height={plotH}
        fill={p.levelSoft.blue}
        opacity={0.45}
      />

      {/* 降雨柱：水位为什么涨，图里要能看出来（雨强柱贴在底部） */}
      {highlight &&
        geo.rainPts.map((r, i) => (
          <rect
            key={i}
            x={px(r.x) - 1.6}
            y={rainY(r.r)}
            width={3.2}
            height={Math.max(0, H - padB - rainY(r.r))}
            fill={p.rain}
            opacity={0.5}
          />
        ))}

      {/* 四级阈值虚线 + 左侧等级字 */}
      {ALARM_LEVELS.map((lv) => {
        const d = thresholdOf(thresholds, lv)
        return (
          <g key={lv}>
            <line
              x1={padL}
              x2={W - 12}
              y1={py(d)}
              y2={py(d)}
              stroke={p.level[lv]}
              strokeWidth={1}
              strokeDasharray="5 5"
              opacity={0.85}
            />
            <text x={6} y={py(d) + 4} fontSize={10} fill={p.level[lv]}>
              {LEVEL_LABEL[lv].slice(0, 1)}
            </text>
          </g>
        )
      })}

      {/* 90% 区间带 */}
      {highlight && geo.fcPts.length > 1 && <path d={bandPath()} fill={p.forecast} opacity={0.17} />}

      {/* 实测线 */}
      {geo.obsPts.length > 1 && (
        <path
          d={line(geo.obsPts, 0.55)}
          fill="none"
          stroke={p.observed}
          strokeWidth={highlight ? 3 : 2.4}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {/* 预测线 */}
      {geo.fcPts.length > 1 && (
        <path
          d={line(geo.fcPts)}
          fill="none"
          stroke={p.forecast}
          strokeWidth={highlight ? 3 : 2.4}
          strokeDasharray="7 4"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}

      {/* 现在竖线 */}
      <line x1={px(geo.nowOff)} x2={px(geo.nowOff)} y1={padT - 6} y2={H - padB} stroke={p.accent} strokeWidth={1.6} />
      <text x={px(geo.nowOff) + 5} y={padT - 9} fontSize={11} fill={p.accent}>
        现在
      </text>

      {/* 当前值标注：大屏最常读的一个数，把它钉在曲线末端 */}
      {highlight && cur && (
        <g>
          <circle cx={px(curX)} cy={py(cur.d)} r={4.5} fill={p.observed} stroke="#fff" strokeWidth={1.6} />
          <text x={px(curX) - 8} y={py(cur.d) - 9} fontSize={13} fontWeight={700} fill={p.observed} textAnchor="end">
            {cur.d.toFixed(2)}m
          </text>
        </g>
      )}
      {/* 预测峰值标注 */}
      {highlight && fcPeak.y > 0 && (
        <g>
          <circle cx={px(fcPeak.x)} cy={py(fcPeak.y)} r={3.6} fill={p.forecast} stroke="#fff" strokeWidth={1.4} />
          <text x={px(fcPeak.x) + 7} y={py(fcPeak.y) + 4} fontSize={11.5} fontWeight={600} fill={p.forecast}>
            峰值 {fcPeak.y.toFixed(2)}m
          </text>
        </g>
      )}

      {/* 时间刻度 */}
      {[0, 0.25, 0.5, 0.75, 1].map((k) => (
        <text
          key={k}
          x={px(geo.span * k)}
          y={H - 8}
          fontSize={10.5}
          fill={p.textFaint}
          textAnchor={k === 0 ? 'start' : k === 1 ? 'end' : 'middle'}
        >
          {fmtTime((geo.t0 + geo.span * k) as SimTime, 'HH:mm')}
        </text>
      ))}
      {/* 雨强刻度说明 */}
      {highlight && (
        <text x={padL + 4} y={H - padB - 3} fontSize={9.5} fill={p.rain}>
          雨强 峰值 {maxRain.toFixed(1)} mm/h
        </text>
      )}
    </svg>
  )
}
