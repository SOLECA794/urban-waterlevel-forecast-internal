import { useEffect, useMemo, useRef, useState } from 'react'
import type { HorizonMin, Level, Meters, SimTime, SiteForecast, Thresholds } from '../domain'
import {
  ALARM_LEVELS,
  DISPOSITION_LABEL,
  HORIZONS,
  LEVEL_FULL,
  LEVEL_LABEL,
  LEVEL_RANK,
  depthOf,
  fmtMinutes,
  fmtTime,
  horizonLabel,
  isAlarm,
  maxLevel,
  redThreshold,
} from '../domain'
import {
  useAlerts,
  useAllHistory,
  useForecast,
  useOverview,
  useSiteDetail,
  useSites,
  type OverviewRow,
} from '../data/queries'
import { PALETTE, PaletteCtx, usePalette, type Palette } from './theme'
import { techGridUri } from './panel'
import { BarRow, BigStat, Donut, LevelTag, LiveDot, Panel } from './parts'
import { TrendChart as TrendBoard } from './TrendChart'
import { RealMap } from './RealMap'
import { Widget } from './widget'
import {
  PRESET_LABEL,
  PRESETS,
  WIDGET_IDS,
  clearLayout,
  loadLayout,
  saveLayout,
  type BoardLayout,
  type PresetName,
  type Rect,
  type WidgetId,
} from './layout'
import { SCENES, SceneProvider } from './scene'
import { useSceneRotation } from './useRotation'
import { ZoneCellView, sharedDomain, type ZoneCell, type ZoneSeries } from './ZoneGrid'
import {
  Confidence,
  DistrictCompare,
  Heatmap,
  RiskQuadrant,
  type HeatCell,
  TrendOutlook,
  projectTrend,
  type ConfidenceRow,
  type DistrictCompareRow,
  type HeatRow,
  type RiskPoint,
  type TrendPoint,
} from './AnalysisBoard'

/**
 * 大厅大屏 —— 三屏轮播，无人交互。
 *
 * 三屏各讲一件事：**全域总览**（11 块，值班常驻）、**辖区预测**（6 格，
 * 看哪个区最先翻红）、**全域研判**（7 块，看这波往哪走）。
 * 每屏内部按「KPI 条 → 主图 → 明细」三层组织，不是把组件平铺成等大方块。
 * 切屏用整层叠化，不是新开路由 —— 大屏没有导航，观众不会去点。
 *
 * 三层的说法已经作废，现在是两层，而且没有暗色层：
 *   1. 真实地图底图（高德浅色路网瓦片，铺满整屏，不倾斜）
 *   2. 实色白卡（#FFFFFF + 四级阴影，无 backdrop-filter）浮在上面
 *
 * 三条硬约束（都是评审逐轮打回来的）：
 *   - 不接抽象示意图，要真实地图：值班看屏第一反应是「这条街我认不认识」。
 *   - 整页不许有暗区：深色演播室背景与四周压暗都删了，最底层是浅色天光。
 *   - 面板半透明但不毛玻璃：模糊会把街道糊成一片奶白，层次反而塌。
 *
 * 场景层的契约见 `scene.tsx`；动效与轮播纪律见 `useRotation.ts`；
 * 完整设计契约见 `docs/10-大屏轮播场景设计契约.md`。
 */

/** 决策信号的中文名。键来自引擎的 agent._signals()，写死在这里是有意的：
 *  它是前后端之间的一份「词汇表」，改外键名时必须在这里同步，否则界面上会露出 rain_now 这种内部命名。 */
const SIGNAL_LABEL: Record<string, string> = {
  rain_now: '当前雨强',
  rain_sum_1h: '近 1h 雨量',
  fc_1h: '1h 预报',
  fc_3h: '3h 预报',
  depth: '积水深',
  slope_1h: '1h 涨速',
  quality: '数据质量',
  thr_blue: '蓝阈',
  headroom_blue: '距蓝阈',
}

const STATION_MS = 9000

/** 热力图的列数：过去 6 小时 + 未来 6 小时，每小时一格。 */
const HEAT_COLS = 12
const W = 1920
const H0 = 1080

/** 十二小时预测迷你曲线：一行一站，峰值打点。 */
function MiniCurve({ sf, site, p, height = 18 }: { sf: SiteForecast; site: { baseLevel: Meters; thresholds: Thresholds }; p: Palette; height?: number }) {
  const Wd = 100
  const depths = sf.curve.map((c) => Math.max(0, Number(depthOf(c.level, site.baseLevel))))
  const red = Number(redThreshold(site.thresholds))
  const max = Math.max(red * 1.5, Math.max(...depths, 0) * 1.1, 0.08)
  const y = (d: number) => height - 1.5 - (Math.min(d, max) / max) * (height - 4)
  const path = depths.map((d, i) => `${i === 0 ? 'M' : 'L'}${((i / Math.max(1, depths.length - 1)) * Wd).toFixed(2)} ${y(d).toFixed(2)}`).join(' ')
  const pi = depths.indexOf(Math.max(...depths))
  const px = (pi / Math.max(1, depths.length - 1)) * Wd
  return (
    <svg viewBox={`0 0 ${Wd} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height }}>
      <rect x={0} y={0} width={Wd} height={Math.max(0, y(red))} fill={p.level.red} opacity={0.1} />
      <line x1={0} y1={y(red)} x2={Wd} y2={y(red)} stroke={p.level.red} strokeWidth={0.8} opacity={0.45} strokeDasharray="3 3" />
      <path d={path} fill="none" stroke={p.forecast} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <circle cx={px} cy={y(depths[pi] ?? 0)} r={2.4} fill={p.level.red} />
    </svg>
  )
}

/** 综合分环形。 */
function ScoreRing({ score, level, size = 70 }: { score: number; level: Level; size?: number }) {
  const p = usePalette()
  const r = (size - 10) / 2
  const c = 2 * Math.PI * r
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: `0 0 ${size}px` }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={p.panelLine} strokeWidth={7} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={p.level[level]}
          strokeWidth={7}
          strokeLinecap="round"
          strokeDasharray={`${Math.max(0, Math.min(1, score)) * c} ${c}`}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <b style={{ fontSize: 18, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{score.toFixed(2)}</b>
        <span style={{ fontSize: 9, color: p.textFaint, marginTop: 2 }}>综合分</span>
      </div>
    </div>
  )
}

/** 键值行。 */
function Row({ label, value, p, strong }: { label: string; value: string; p: Palette; strong?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 8,
        padding: '3px 0',
        borderBottom: `1px solid ${p.panelLine}`,
      }}
    >
      <span style={{ fontSize: 10.5, color: p.textFaint, whiteSpace: 'nowrap', letterSpacing: 0.2 }}>{label}</span>
      <span
        style={{
          fontSize: strong ? 13 : 12,
          fontWeight: strong ? 700 : 500,
          color: strong ? p.text : p.textDim,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
    </div>
  )
}



/** 大屏用到的几个关键帧与工具类。放在一个函数里返回字符串，避免额外一个 css 文件。 */
function boardCss(): string {
  return `
  /* 面板入场：位移 + 微缩，比纯淡入更「有重量」；delay 由外层 inline 控制 */
  @keyframes bpRise {
    from { opacity: 0; transform: translateY(10px) scale(.985); }
    to   { opacity: 1; transform: none; }
  }
  /* 数值刚更新时的一下呼吸，替代满屏闪烁 */
  @keyframes bpGlow {
    0%   { box-shadow: 0 0 0 0 rgba(30,111,168,0.28); }
    70%  { box-shadow: 0 0 0 10px rgba(30,111,168,0); }
    100% { box-shadow: 0 0 0 0 rgba(30,111,168,0); }
  }
  .bp-fade { animation: bpFade 520ms ease both; }
  @keyframes bpFade {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: none; }
  }
  .bp-live { animation: bpLive 1.8s ease-in-out infinite; }
  @keyframes bpLive {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(34,211,238,0.55); }
    50%      { opacity: 0.75; box-shadow: 0 0 0 4px rgba(34,211,238,0); }
  }
  /* 场景叠化：整层淡出 → 换版面 → 淡入。
     两段都短（180ms / 320ms）：大屏是给远处的人看的，
     淡入淡出拖长了就像幻灯片在「找下一张」，反而打断注意力。 */
  .bp-stage-in { animation: bpStageIn 320ms cubic-bezier(.22,.68,.28,1) both; }
  @keyframes bpStageIn {
    from { opacity: 0; transform: scale(1.012); }
    to   { opacity: 1; transform: none; }
  }
  .bp-stage-out { animation: bpStageOut 180ms ease both; }
  @keyframes bpStageOut {
    from { opacity: 1; }
    to   { opacity: 0; }
  }
  /* 轮播进度条：CSS 动画推进，逐帧 setState 会让整棵 1920×1080 的树 60fps 重渲染 */
  @keyframes bpProgress {
    from { transform: scaleX(0); }
    to   { transform: scaleX(1); }
  }
  .bp-fade, .bp-live { will-change: opacity, transform; }
  `
}

export default function BoardPage() {
  const p = PALETTE
  const hostRef = useRef<HTMLDivElement | null>(null)
  /** 画布逻辑高度：宽度铺满视口后，按同一 scale 反推纵向需要多少逻辑高度。
   *  固定 1080 的话，宽屏（如 1410×628，比例 2.245）等比缩放后宽度只用 79%，
   *  右侧留一大片空白——这正是「整页只显示了一点」的根因。
   *  改成随视口浮动后：宽度必然铺满，纵向也必然铺满，且仍是等比（圆形不会压扁）。 */
  const H = H0
  const [scale, setScale] = useState(1)

  /* 版面状态：预设 + 手工拖动，落 localStorage。
     为什么需要 ref 兜一层：拖拽松手时才写盘，而写盘要拿到「最新的」layout，
     直接读 state 会拿到闭包里那一刻的旧值。 */
  const [layout, setLayout] = useState<BoardLayout>(() => loadLayout())
  const [editing, setEditing] = useState(() => new URLSearchParams(window.location.search).get('edit') === '1')
  const layoutRef = useRef(layout)
  useEffect(() => {
    layoutRef.current = layout
  }, [layout])
  const setRect = (id: WidgetId, next: Rect) =>
    setLayout((L) => ({ preset: 'custom', rects: { ...L.rects, [id]: next } }))
  const applyPreset = (name: PresetName) => {
    const next: BoardLayout = { preset: name, rects: { ...PRESETS[name] } }
    setLayout(next)
    saveLayout(next)
  }

  /* ------------------------------------------------------------------
     场景轮播。

     轮播不是「切页面」，是「同一块画布按节拍换一套版面」。所以：
       - 目标场景由 useSceneRotation 推进（到点换屏）；
       - 实际渲染的场景由下面的两阶段叠化控制：
         先把整层淡出，再换坐标，最后淡入。
         这样地图瓦片、图表都是按最终尺寸一次性算好的，
         不会出现过渡中容器被拉伸、瓦片没铺满的破面。
       - 「主页」沿用用户手拖过的版面；其余场景用各自固定坐标。
         没被场景显式指定坐标的组件继续沿用当前版面，于是
         「切到别的场景再切回来」不会把用户调好的主页版面弄丢。
  ------------------------------------------------------------------ */
  const sceneParams = useMemo(() => new URLSearchParams(window.location.search), [])
  const sceneLocked = sceneParams.get('scene') != null
  const initialScene = useMemo(() => {
    const raw = sceneParams.get('scene')
    const n = raw == null ? NaN : Number(raw)
    return Number.isFinite(n) && n >= 0 && n < SCENES.length ? n : 0
  }, [sceneParams])

  const carousel = useSceneRotation({
    count: SCENES.length,
    durationMs: (i) => SCENES[i]?.durationMs ?? 18000,
    locked: sceneLocked,
    initial: initialScene,
  })

  // 渲染中的场景（叠化落后于目标场景）
  const [shown, setShown] = useState(carousel.index)
  // 'in' = 正常显示；'out' = 正在淡出，等它落完再换版面
  const [phase, setPhase] = useState<'in' | 'out'>('in')
  useEffect(() => {
    if (carousel.index === shown) return
    setPhase('out')
    const t = window.setTimeout(() => {
      setShown(carousel.index)
      setPhase('in')
    }, 180)
    return () => window.clearTimeout(t)
  }, [carousel.index, shown])

  const scene = SCENES[shown] ?? SCENES[0]
  const rects = useMemo<Record<WidgetId, Rect>>(
    () => ({ ...layout.rects, ...scene.rects }) as Record<WidgetId, Rect>,
    [layout.rects, scene.rects],
  )
  const visibleWidgets = useMemo<ReadonlySet<WidgetId>>(
    () => new Set(scene.widgets === 'all' ? WIDGET_IDS : scene.widgets),
    [scene.widgets],
  )

  const sceneKey = scene.key

  // 「此刻态势」有四层内容（两大数 / 最深处与距阈 / 退涨指示 / 底部两大数），
  // 实测需要 142px。某些屏为了把高度让给主图，只给它 120px，
  // 于是底部两大数被裁掉（measure-overflow 报溢出 58px）。
  // 不看场景名、只看实际分配到的矩形高度：用户在布局模式里把面板拖高之后，
  // 内容应当自己长回来，而不是因为"它是地图屏"就永远少一行。
  const situationH = (rects.situation?.h ?? 0) * scale
  const situationCompact = situationH > 0 && situationH < 150

  /**
   * 手动切场景：只切屏，不停轮播。
   * 停轮播是「进布局编辑态」才做的事——那会儿用户要拖组件，
   * 边转边拖会被场景切换立刻顶掉。
   */
  const gotoScene = (i: number) => carousel.setIndex(i)

  useEffect(() => {
    const apply = () => {
      // 取两轴的较小比例：任何视口下 1920×1080 的版面都完整可见，
      // 一个面板都不会被裁掉。空出来的边由底色与外圈留白承担。
      const s = Math.min(window.innerWidth / W, window.innerHeight / H0)
      setScale(s)
    }
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])

  // 平台运维类面板已从大屏撤掉（它们在管理页里更合适），
  // 对应的 useHealth/useAudit/useDeliveries/useModelVersions 一并停止调用 ——
  // 没人看的数据每几秒拉一次是纯浪费。

  const overview = useOverview()
  const forecast = useForecast()
  // 十站过去 12 小时的真实历史，一次请求取回。热力图左半段和全域趋势都靠它 ——
  // 早先用「当前等级」填满过去六列，图形看着是满的，实际没有信息。
  const allHistory = useAllHistory(12)
  const alerts = useAlerts(false)
  // 0.2 而不是 0.34：倾斜铺满后整体放大约 1.9 倍，0.34 的气泡直径近 90px，
  // 把街区和相邻站点全压住了。地图上的气泡应当是「标记」，不是数据图形。
  // 真实地图直接吃经纬度：MapPoint 只有投影后的 x/y，瓦片要用原始 lon/lat
  const mapPoints = useMemo(
    () =>
      (overview.data?.rows ?? []).map((r) => ({
        id: r.site.id,
        name: r.site.name,
        lon: r.site.lon,
        lat: r.site.lat,
        level: r.assessment.level,
        depth: Number(r.reading.depth),
        isAlarm: isAlarm(r.assessment.level),
      })),
    [overview.data],
  )
  const sites = useSites()

  const rows = overview.data?.rows ?? []
  const list = useMemo(
    () => [...rows].sort((a, b) => LEVEL_RANK[b.assessment.level] - LEVEL_RANK[a.assessment.level] || b.assessment.score - a.assessment.score),
    [rows],
  )
  const worst = maxLevel(list.map((r) => r.assessment.level))
  const anchor = (overview.data?.issuedAt ?? forecast.data?.issuedAt ?? 0) as SimTime

  const stationRotation = useMemo(() => [...list.filter((r) => isAlarm(r.assessment.level)), ...list.filter((r) => !isAlarm(r.assessment.level))], [list])
  const [idx, setIdx] = useState(0)
  useEffect(() => {
    if (stationRotation.length <= 1) return
    const t = setInterval(() => setIdx((i) => (i + 1) % stationRotation.length), STATION_MS)
    return () => clearInterval(t)
  }, [stationRotation.length])
  const safeIdx = Math.min(idx, Math.max(0, stationRotation.length - 1))
  const cur: OverviewRow | undefined = stationRotation[safeIdx]
  const detail = useSiteDetail(cur?.site.id ?? '')
  const curSite = sites.data?.find((x) => x.id === cur?.site.id) ?? cur?.site
  const asm = detail.data?.forecast?.assessment ?? cur?.assessment

  const counts = ALARM_LEVELS.map((lv) => ({ level: lv, value: list.filter((r) => r.assessment.level === lv).length })).filter((c) => c.value > 0)
  const noneCount = list.filter((r) => r.assessment.level === 'none').length

  const deepest = list.reduce<OverviewRow | undefined>((a, r) => (r.reading.depth > (a?.reading.depth ?? -1) ? r : a), undefined)
  const raining = list.filter((r) => r.reading.rain >= 1).length
  const maxRain = list.reduce((a, r) => Math.max(a, Number(r.reading.rain)), 0)

  const density = useMemo(() => {
    const evs = alerts.data ?? []
    const buckets = Array.from({ length: 12 }, () => 0)
    // 「现在」优先用仿真时钟；拿不到就退到最新一条告警的时刻。
    // 之前直接用 anchor（可能是 0），减出来的桶号全为负，12 格永远是空的。
    const now = Number(anchor) || evs.reduce((a, e) => Math.max(a, Number(e.raisedAt)), 0)
    if (!now) return buckets
    for (const e of evs) {
      const h = Math.floor((now - Number(e.raisedAt)) / 7200)
      if (h >= 0 && h < 12) buckets[h] += 1
    }
    return buckets
  }, [alerts.data, anchor])

  const compare = useMemo(() => {
    const byDepth = [...list].sort((a, b) => Number(b.reading.depth) - Number(a.reading.depth)).slice(0, 4)
    const rising = list.some((r) => Number(r.reading.trend1h) > 0.005)
    const trendSorted = rising
      ? [...list].sort((x, y) => Number(y.reading.trend1h) - Number(x.reading.trend1h))
      : [...list].sort((x, y) => Number(x.reading.trend1h) - Number(y.reading.trend1h))
    return { byDepth, fastest: trendSorted[0], rising }
  }, [list])

  const fcItems = useMemo(() => {
    const fc = forecast.data
    if (!fc) return []
    return list
      .map((r) => ({ r, sf: fc.sites[r.site.id] }))
      .filter((x): x is { r: OverviewRow; sf: SiteForecast } => !!x.sf)
      .sort((a, b) => Number(b.sf.assessment.peakValue) - Number(a.sf.assessment.peakValue))
      .slice(0, 10)
  }, [forecast.data, list])

  // ---------------------------------------------------------------- 辖区预测格
  /**
   * 「辖区预测」屏的六格：五个街道各一格 + 一格「全域合计」。
   *
   * 六格共用一条纵轴（由 sharedDomain 负责），否则「东城看着比西城高」
   * 可能只是两格的刻度不同——那是彻底的误读。
   *
   * 曲线点取自 `forecast.sites[id].curve`，是引擎发布的完整 5 分钟粒度曲线，
   * 不是四个预见期插值出来的：插值会抹平拐点，而「最先穿红」恰好发生在拐点上。
   */
  const zoneCells = useMemo<ZoneCell[]>(() => {
    const fc = forecast.data
    if (!fc) return []

    const byDistrict = new Map<string, OverviewRow[]>()
    for (const r of list) {
      const key = r.site.district || '未分区'
      const arr = byDistrict.get(key) ?? []
      arr.push(r)
      byDistrict.set(key, arr)
    }

    const build = (district: string, members: readonly OverviewRow[]): ZoneCell => {
      const zseries: ZoneSeries[] = []
      let peak: ZoneCell['peak'] = null
      let crossRed: number | null = null
      let topLevel: Level = 'none'
      let maxDepth = 0
      const thr0 = members[0]?.site.thresholds
      const thr = {
        blue: Number(thr0?.blue ?? 0.15),
        yellow: Number(thr0?.yellow ?? 0.25),
        orange: Number(thr0?.orange ?? 0.35),
        red: Number(thr0?.red ?? 0.45),
      }

      for (const m of members) {
        const sf = fc.sites[m.site.id]
        const base = Number(m.site.baseLevel)
        const pts = sf ? sf.curve.map((c) => ({ offsetMin: c.offsetMin, level: Number(c.level) - base })) : []
        if (pts.length >= 2) {
          zseries.push({
            siteId: m.site.id,
            name: m.site.name,
            district,
            level: m.assessment.level,
            now: Number(m.reading.depth),
            points: pts,
          })
          for (const pt of pts) {
            if (!peak || pt.level > peak.level) peak = { level: pt.level, atMin: pt.offsetMin, name: m.site.name }
          }
          // 「穿红」用该站自己的红阈：拿辖区最紧张那个站的红阈去衡量别的站是错的。
          // 阈值的量纲是「相对基准的积水深」，和 pts 里的 level 同量纲 ——
          // 早先这里多减了一次 base（写成 thresholds.red - base），得到负数，
          // 于是每个点都「已穿红」、徽标永远显示「此刻后穿红」。
          const red = Number(m.site.thresholds.red)
          const hit = pts.find((pt) => pt.level >= red)
          if (hit && (crossRed == null || hit.offsetMin < crossRed)) crossRed = hit.offsetMin
        }
        if (LEVEL_RANK[m.assessment.level] > LEVEL_RANK[topLevel]) topLevel = m.assessment.level
        maxDepth = Math.max(maxDepth, Number(m.reading.depth))
      }

      return { district, series: zseries, topLevel, maxDepth, peak, crossRedAtMin: crossRed, thresholds: thr }
    }

    const cells = Array.from(byDistrict.entries())
      .map(([d, ms]) => build(d, ms))
      .filter((c) => c.series.length > 0)
      .sort((a, b) => LEVEL_RANK[b.topLevel] - LEVEL_RANK[a.topLevel] || b.maxDepth - a.maxDepth)

    // 最后一格：全域合计。把十站的「水位减基准」加起来，得到全城累计积水深。
    // 它回答的是「这波是面上的雨还是点上的雨」——十站各自一格时看不出来。
    if (cells.length > 0 && cells.length < 6) {
      const sumPts = new Map<number, number>()
      for (const r of list) {
        const sf = fc.sites[r.site.id]
        if (!sf) continue
        const base = Number(r.site.baseLevel)
        for (const c of sf.curve) sumPts.set(c.offsetMin, (sumPts.get(c.offsetMin) ?? 0) + (Number(c.level) - base))
      }
      const pts = Array.from(sumPts.entries()).sort((a, b) => a[0] - b[0]).map(([offsetMin, level]) => ({ offsetMin, level }))
      if (pts.length >= 2) {
        let pk: ZoneCell['peak'] = null
        for (const pt of pts) if (!pk || pt.level > pk.level) pk = { level: pt.level, atMin: pt.offsetMin, name: '全域合计' }
        const sumNow = list.reduce((a, r) => a + Number(r.reading.depth), 0)
        cells.push({
          district: '全域合计',
          series: [{ siteId: '_all', name: '全域合计', district: '全域合计', level: worst, now: sumNow, points: pts }],
          topLevel: worst,
          maxDepth: sumNow,
          peak: pk,
          crossRedAtMin: null,
          // 合计值没有单一阈值：把它当成「十站阈值之和」没有业务含义，
          // 所以这里给一组不可能被触发的值，图上的阈值带自然消失。
          thresholds: { blue: 99, yellow: 99, orange: 99, red: 99 },
        })
      }
    }
    return cells.slice(0, 6)
  }, [forecast.data, list, worst])

  const zoneDomain = useMemo(() => sharedDomain(zoneCells), [zoneCells])

  // ---------------------------------------------------------------- 全域研判
  /** 风险格局：横轴 1h 变幅、纵轴当前积水深。 */
  const riskPoints = useMemo<RiskPoint[]>(
    () =>
      list.map((r) => ({
        siteId: r.site.id,
        name: r.site.name,
        level: r.assessment.level,
        depth: Number(r.reading.depth),
        slope: Number(r.reading.trend1h),
      })),
    [list],
  )
  /** 象限线画在「蓝色阈值」上：业务上「算不算有事」的那条线，不是中位数。 */
  const riskBlue = useMemo(() => {
    const bs = list.map((r) => Number(r.site.thresholds.blue) - Number(r.site.baseLevel))
    return bs.length ? bs.reduce((a, b) => a + b, 0) / bs.length : 0.15
  }, [list])

  /**
   * 热力图：横轴 12 个小时桶（-6h … +5h）、纵轴十个站，格色＝该桶的等级。
   *
   * 左边六格用**真实历史**（`/api/history` 批量取回，一次请求拿十站），
   * 右边六格由预测曲线逐桶折算。早先左半段是拿「当前等级」平铺的，
   * 图形看着满、实际零信息 —— 那才是最容易被误读的一类假图：
   * 它让读者以为过去六小时一直是这样，而实际上什么都没测。
   *
   * 没有历史（新部署、库还空）时该格留空而不是填当前等级，
   * 并由页脚说明「历史不足」—— 不知道就说不知道。
   */
  const heatRows = useMemo<HeatRow[]>(
    () =>
      list.map((r) => {
        const sf = forecast.data?.sites[r.site.id]
        const base = Number(r.site.baseLevel)
        const t = r.site.thresholds
        // 阈值本身就是「相对基准的积水深」，和下面的 d 同量纲，**不要再减 base**
        // （减了会得到负数，于是每一格都被判成 red，整张热力图全红）。
        const ths = [Number(t.blue), Number(t.yellow), Number(t.orange), Number(t.red)]
        const cls = (d: number): Level =>
          d >= ths[3] ? 'red' : d >= ths[2] ? 'orange' : d >= ths[1] ? 'yellow' : d >= ths[0] ? 'blue' : 'none'
        const pts = allHistory.data?.[r.site.id]?.points ?? []
        // 时间轴以「最新一条遥测」为原点（仿真秒），和预测曲线的 offsetMin 同一把尺子。
        const lastAt = pts.length ? Number(pts[pts.length - 1].at) : 0
        const levels: HeatCell[] = []
        for (let i = 0; i < HEAT_COLS; i++) {
          // 与 <Heatmap columns> 用同一把尺子：左 6 格是 -6h…-1h，右 6 格是 0…+5h。
          // 早先这里写成 (i - HEAT_COLS + 1) * 60，得到 -10h…+1h，
          // 与横轴标签整整错开 4 格，历史点全部匹配不到、整片留白。
          // 一小时一格，覆盖 -5h…+6h，「现在」落在第 6 格（i=5）。
          // 与 <Heatmap columns> 的 (i - 5) * 60 必须一致。
          const offset = (i - 5) * 60
          if (offset <= 0) {
            // 过去：取该桶（offset 对应的那一分钟）前后 30 分钟里最近的一条实测。
            // 一条都没有就留 none —— 不知道就说不知道，不要拿别处的数字顶上。
            let bestD: number | null = null
            let bestGap = Infinity
            if (lastAt) {
              const want = lastAt + offset * 60
              for (const p of pts) {
                const gap = Math.abs(Number(p.at) - want)
                if (gap <= 30 * 60 && gap < bestGap) {
                  bestGap = gap
                  bestD = Number(p.level) - base
                }
              }
            }
            levels.push(bestD == null ? 'blank' : cls(bestD))
          } else {
            // 未来：按预测曲线折算。
            const pt = sf ? sf.curve.find((c) => c.offsetMin >= offset) : undefined
            levels.push(pt ? cls(Number(pt.level) - base) : 'blank')
          }
        }
        return { siteId: r.site.id, name: r.site.name, district: r.site.district || '未分区', levels }
      }),
    [list, forecast.data, allHistory.data],
  )

  /**
   * 全域趋势：合计积水深的时间走势，过去 6h 取真实历史、未来 6h 取预测曲线。
   *
   * 早先这里只从预测曲线里取 `offsetMin <= 0` 的点 —— 而曲线是从此刻往前的，
   * 一个负 offset 都没有，所以数组恒空、面板永远显示「等待历史数据」。
   * 现在两段拼起来：左边实测、右边预测，中间由 `now` 分界。
   */
  const trendHistory = useMemo<TrendPoint[]>(() => {
    const fc = forecast.data
    const hist = allHistory.data
    if (!fc && !hist) return []

    // ---- 过去：把十站的实测序列按时间戳对齐后求和。
    const pastSums = new Map<number, number>()
    if (hist) {
      for (const r of list) {
        const ser = hist[r.site.id]
        if (!ser) continue
        const base = Number(r.site.baseLevel)
        // 每 30 分钟取一个点，避免十站 × 289 点把横轴压得过密。
        for (const pt of ser.points) {
          const bucket = Math.round(Number(pt.at) / 1800) * 1800
          pastSums.set(bucket, (pastSums.get(bucket) ?? 0) + Math.max(0, Number(pt.level) - base))
        }
      }
    }
    const pastKeys = Array.from(pastSums.keys()).sort((a, b) => a - b)
    const lastPast = pastKeys.length ? pastKeys[pastKeys.length - 1] : 0
    // 只保留最近 6 小时（12 个半小时桶），offsetMin 相对「此刻」为负。
    const past: TrendPoint[] = pastKeys
      .slice(-13)
      .map((k) => ({ offsetMin: lastPast ? (k - lastPast) / 60 : 0, sumDepth: pastSums.get(k) ?? 0 }))

    // ---- 未来：逐站预测曲线求和，同样每 30 分钟一桶。
    const futureSums = new Map<number, number>()
    if (fc) {
      for (const r of list) {
        const sf = fc.sites[r.site.id]
        if (!sf) continue
        const base = Number(r.site.baseLevel)
        for (const c of sf.curve) {
          if (c.offsetMin <= 0 || c.offsetMin > 360) continue
          const bucket = Math.round(c.offsetMin / 30) * 30
          futureSums.set(bucket, (futureSums.get(bucket) ?? 0) + Math.max(0, Number(c.level) - base))
        }
      }
    }
    const future: TrendPoint[] = Array.from(futureSums.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([offsetMin, sumDepth]) => ({ offsetMin, sumDepth }))

    return [...past, ...future]
  }, [forecast.data, allHistory.data, list])
  const trendOutlook = useMemo(() => projectTrend(trendHistory, 6), [trendHistory])

  /** 可信度：12h 那条预见期的 90% 区间半宽。 */
  const confidenceRows = useMemo<ConfidenceRow[]>(() => {
    const fc = forecast.data
    if (!fc) return []
    const out: ConfidenceRow[] = []
    for (const r of list) {
      const sf = fc.sites[r.site.id]
      if (!sf || !sf.horizons.length) continue
      const h = sf.horizons.find((x) => x.horizonMin === 720) ?? sf.horizons[sf.horizons.length - 1]
      out.push({
        siteId: r.site.id,
        name: r.site.name,
        district: r.site.district || '未分区',
        level: r.assessment.level,
        halfWidth: (Number(h.upper) - Number(h.lower)) / 2,
        fcLevel: Number(h.level),
      })
    }
    return out.sort((a, b) => b.halfWidth - a.halfWidth)
  }, [forecast.data, list])

  /** 多区对比：每区最深、12h 峰值、超阈占比。 */
  const districtCompare = useMemo<DistrictCompareRow[]>(() => {
    const fc = forecast.data
    const by = new Map<string, OverviewRow[]>()
    for (const r of list) {
      const k = r.site.district || '未分区'
      const arr = by.get(k) ?? []
      arr.push(r)
      by.set(k, arr)
    }
    const out: DistrictCompareRow[] = []
    for (const [district, ms] of by.entries()) {
      let topLevel: Level = 'none'
      let maxDepth = 0
      let alarmCount = 0
      let rain = 0
      let peak: number | null = null
      for (const m of ms) {
        if (LEVEL_RANK[m.assessment.level] > LEVEL_RANK[topLevel]) topLevel = m.assessment.level
        maxDepth = Math.max(maxDepth, Number(m.reading.depth))
        if (isAlarm(m.assessment.level)) alarmCount++
        rain = Math.max(rain, Number(m.reading.rain))
        const sf = fc?.sites[m.site.id]
        if (sf) {
          const base = Number(m.site.baseLevel)
          for (const c of sf.curve) {
            const d = Number(c.level) - base
            peak = peak == null ? d : Math.max(peak, d)
          }
        }
      }
      out.push({ district, topLevel, maxDepth, alarmCount, siteCount: ms.length, peak, rain })
    }
    return out.sort((a, b) => LEVEL_RANK[b.topLevel] - LEVEL_RANK[a.topLevel] || b.maxDepth - a.maxDepth)
  }, [list, forecast.data])

  const series = detail.data?.series ?? null
  const detailFc = detail.data?.forecast ?? null
  const hz = (h: HorizonMin) => {
    if (!detailFc) return null
    return detailFc.horizons.find((x) => x.horizonMin === h) ?? null
  }

  return (
    <PaletteCtx.Provider value={p}>
      <style>{boardCss()}</style>
      {/* 外层只负责把画布摆在视口里，**不能裁**。
          早先这里是 position:fixed + inset:0 + overflow:hidden：
          盒子被钉死在视口高度上，而缩放后的画布比视口高（1410×628 的
          宽屏里，scale=0.734 时 1080 逻辑高会变成 793px），
          超出的部分被 overflow 直接剪掉——底部整整一行面板凭空消失，
          这就是「整个页面上就显示了一点」。
          现在：外层按缩放后的真实占位撑开，画布始终完整可见。 */}
      <div
        ref={hostRef}
        style={{
          position: 'fixed',
          inset: 0,
          overflow: 'hidden',
          // 外圈不留一块"没渲染"的白：沿用画布底色的最浅一档，
          // 视觉上读成「版面外缘」而不是「内容没铺满」。
          background: 'linear-gradient(180deg, #E7F0F9 0%, #D9E8F5 60%, #CFE2F3 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            // 用负 margin 之外的另一种做法：占位盒声明缩放后的尺寸，
            // 让外层能滚到画布真正的右下角，而不是按未缩放的 1920 算。
            width: W * scale,
            height: H * scale,
            flex: '0 0 auto',
            position: 'relative',
          }}
        >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            transformOrigin: 'top left',
            transform: `scale(${scale})`,
          }}
        >
        <div
          style={{
            width: W,
            height: H,
            position: 'relative',
            overflow: 'hidden',
            color: p.text,
            // 不要再有任何暗区：整页最底层就是一层浅色天光。
            // 但"没有暗区"不等于"整页一块纯色"——实测面板近白占比 56%，
            // 背景只在 12px 栏缝里露出一条同样发白的边，整屏读起来就是白压白。
            // 现在四层叠结构：底色（深一档） + 网格（看得见） + 柔光（打破平铺） + 顶部冷光。
            //
            // background-image 里**先写的在上层**（与直觉相反）：
            // 柔光在最上、网格在柔光之下、底色渐变垫底，网格才会被柔光染色。
            backgroundColor: '#DAE8F6',
            backgroundImage:
              `radial-gradient(120% 90% at 12% 4%, rgba(0,151,167,0.20) 0%, rgba(0,151,167,0) 55%), ` +
              `radial-gradient(120% 95% at 88% 8%, rgba(21,101,192,0.22) 0%, rgba(21,101,192,0) 58%), ` +
              `linear-gradient(180deg, rgba(226,240,252,0.85) 0%, rgba(226,240,252,0) 22%), ` +
              techGridUri('rgba(21,101,192,0.17)', 32) + `, ` +
              `linear-gradient(180deg, #EAF2FB 0%, #DCE9F6 52%, #CFE2F3 100%)`,
            backgroundRepeat: 'no-repeat, no-repeat, no-repeat, repeat, no-repeat',
            backgroundSize: '100% 100%, 100% 100%, 100% 100%, 32px 32px, 100% 100%',
          }}
        >
          

          {/* 地图不再是背景，而是一个普通组件（见下面 id="map" 的 Widget）。
              原来把真实瓦片铺满整屏有三个代价：
                ① 为了压住路名与卡片文字抢注意力，得盖一层白纱，结果地图本身也糊了；
                ② 整块屏幕只有一张图，能放的信息量被它锁死；
                ③ 含地图的组件一多就会和背景打架。
              拆成组件之后，地图要多大就多大，想放哪儿放哪儿，剩下的位置全给数据。 */}

          {/* 屏幕内投影：只在四边压一道 60px 的极淡灰，模拟「这是一块嵌进墙里的屏」。
              注意是灰色不是黑色 —— 黑色会把用户的「不许有暗区」直接违反。 */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 2,
              pointerEvents: 'none',
              boxShadow:
                'inset 0 0 60px 0 rgba(12,60,90,0.10), inset 0 0 0 1px rgba(12,60,90,0.10)',
            }}
          />



          {/* ------------------------------------------------ 顶栏 */}
          <header
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: 62,
              zIndex: 5,
              display: 'flex',
              alignItems: 'center',
              gap: 18,
              padding: '0 20px',
              background: 'linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(255,255,255,0.80) 72%, rgba(255,255,255,0) 100%)',
              borderBottom: '1px solid rgba(12,60,90,0.07)',
              boxShadow: '0 1px 0 rgba(255,255,255,0.9), 0 6px 18px -12px rgba(12,60,90,0.35)',
            }}
          >
            {/* 标题左侧的竖条：顶栏原本只有文字，加一条色带就有了「台标」的位置感 */}
            <span
              aria-hidden
              style={{
                width: 4,
                height: 30,
                borderRadius: 2,
                background: `linear-gradient(180deg, ${p.accent}, ${p.accent2})`,
                boxShadow: `0 0 10px ${p.accent}55`,
                flexShrink: 0,
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 9,
                  background: `linear-gradient(140deg, ${p.accent2}, ${p.accent})`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#fff',
                  fontSize: 15,
                  fontWeight: 800,
                  boxShadow: `0 0 22px ${p.accent2}66`,
                }}
              >
                涝
              </div>
              <div style={{ lineHeight: 1.1 }}>
                <div style={{ fontSize: 24, fontWeight: 800, color: p.text, letterSpacing: 1 }}>台州市黄岩区</div>
                <div style={{ fontSize: 10.5, color: p.textDim, letterSpacing: 3, marginTop: 2 }}>城市内涝监测预警</div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 16 }}>
              <span style={{ fontSize: 11, padding: '4px 10px', borderRadius: 999, background: p.levelSoft.blue, border: `1px solid ${p.accent}33`, color: p.accent }}>
                {list.length} 个监测站
              </span>
              <span style={{ fontSize: 11, padding: '4px 10px', borderRadius: 999, background: p.panel, border: `1px solid ${p.accent}22`, color: p.textDim }}>
                降雨中 {raining} 站 · 最大 {maxRain.toFixed(0)} mm/h
              </span>
            </div>

            {/* 场景切换器。这块屏常年无人操作，轮播是它的主导航，
                所以「现在第几屏」必须一眼可见，而不是藏在某个角落。 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginLeft: 20 }}>
              <span style={{ fontSize: 10, color: p.textFaint, letterSpacing: 1.5, marginRight: 2 }}>
                {shown + 1}/{SCENES.length}
              </span>
              {SCENES.map((s, i) => {
                const active = i === shown
                return (
                  <button
                    key={s.key}
                    onClick={() => gotoScene(i)}
                    title={s.subtitle}
                    style={{
                      fontSize: 11.5,
                      padding: '5px 11px',
                      borderRadius: 999,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      whiteSpace: 'nowrap',
                      border: `1px solid ${active ? p.accent : p.panelLine}`,
                      background: active ? p.accent : 'transparent',
                      color: active ? '#fff' : p.textDim,
                      transition: 'background 220ms ease, color 220ms ease, border-color 220ms ease',
                    }}
                  >
                    {s.title}
                  </button>
                )
              })}
              <button
                onClick={carousel.togglePlay}
                aria-label={carousel.playing ? '暂停轮播' : '继续轮播'}
                title={carousel.playing ? '暂停轮播' : '继续轮播'}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 999,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: `1px solid ${p.panelLine}`,
                  background: 'transparent',
                  color: p.textDim,
                  padding: 0,
                }}
              >
                {/* 播放/暂停用几何图形，不用 emoji：字形在不同系统上不可控 */}
                {carousel.playing ? (
                  <span style={{ display: 'inline-flex', gap: 3 }}>
                    <i style={{ width: 3, height: 11, background: 'currentColor', borderRadius: 1 }} />
                    <i style={{ width: 3, height: 11, background: 'currentColor', borderRadius: 1 }} />
                  </span>
                ) : (
                  <span style={{ width: 0, height: 0, borderTop: '6px solid transparent', borderBottom: '6px solid transparent', borderLeft: '9px solid currentColor', marginLeft: 2 }} />
                )}
              </button>
              <span
                style={{
                  fontSize: 10.5,
                  color: p.textFaint,
                  maxWidth: 210,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  marginLeft: 4,
                }}
              >
                {scene.subtitle}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
              {(Object.keys(PRESETS) as PresetName[]).map((name) => (
                <button
                  key={name}
                  onClick={() => applyPreset(name)}
                  style={{
                    fontSize: 11,
                    padding: '4px 10px',
                    borderRadius: 999,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    border: `1px solid ${layout.preset === name ? p.accent : 'transparent'}`,
                    background: layout.preset === name ? p.levelSoft.blue : 'transparent',
                    color: layout.preset === name ? p.accent : p.textDim,
                  }}
                >
                  {PRESET_LABEL[name]}
                </button>
              ))}
              <button
                onClick={() => {
                  setEditing((v) => {
                    const next = !v
                    if (next) {
                      // 进编辑态：回到主页并停轮播。
                      // 预设与拖拽只改主页的版面，边转边拖会被场景切换立刻顶掉，
                      // 用户会以为「拖了没反应」。
                      gotoScene(0)
                      if (!sceneLocked) carousel.setPlaying(false)
                    } else if (!sceneLocked) {
                      carousel.setPlaying(true)
                    }
                    return next
                  })
                }}
                style={{
                  fontSize: 11,
                  padding: '4px 12px',
                  borderRadius: 999,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  border: `1px solid ${editing ? p.accent : p.panelLine}`,
                  background: editing ? p.accent : p.panel,
                  color: editing ? '#fff' : p.textDim,
                }}
              >
                {editing ? '完成' : '调整布局'}
              </button>
              {editing && (
                <button
                  onClick={() => {
                    clearLayout()
                    const next: BoardLayout = { preset: 'balanced', rects: { ...PRESETS.balanced } }
                    setLayout(next)
                    saveLayout(next)
                  }}
                  style={{
                    fontSize: 11,
                    padding: '4px 10px',
                    borderRadius: 999,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    border: `1px solid ${p.panelLine}`,
                    background: 'transparent',
                    color: p.textDim,
                  }}
                >
                  复位
                </button>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              {worst !== 'none' && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 7,
                    padding: '5px 12px',
                    borderRadius: 999,
                    background: `${p.level[worst]}22`,
                    border: `1px solid ${p.level[worst]}88`,
                    color: p.levelInk[worst],
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  <i className="bp-live" style={{ width: 7, height: 7, borderRadius: 999, background: p.level[worst] }} />
                  {list.filter((r) => isAlarm(r.assessment.level)).length} 站 {LEVEL_FULL[worst]}
                </span>
              )}
              <span style={{ fontSize: 13, color: p.textDim, fontVariantNumeric: 'tabular-nums' }}>
                {anchor ? fmtTime(anchor, 'MM-DD HH:mm:ss') : '—'}
              </span>
              <LiveDot label="实时" />
            </div>
          </header>

          {/* 轮播进度条：贴在顶栏下沿，当成标题栏的一条下划线。
              进度由 CSS 动画推进，不逐帧 setState —— 见 useRotation.ts 的纪律 2。 */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 60,
              height: 2.5,
              zIndex: 6,
              background: 'rgba(12,60,90,0.08)',
              pointerEvents: 'none',
            }}
          >
            <div
              key={`pg-${carousel.index}`}
              style={{
                height: '100%',
                width: '100%',
                transformOrigin: 'left center',
                transform: 'scaleX(0)',
                background: `linear-gradient(90deg, ${p.accent}, ${p.accent2})`,
                animation: `bpProgress ${SCENES[carousel.index]?.durationMs ?? 18000}ms linear forwards`,
                animationPlayState: carousel.playing ? 'running' : 'paused',
              }}
            />
          </div>

          {/* ------------------------------------------------ 三栏 */}
          {/* 场景叠化：整层淡出 → 换版面 → 淡入。
              逐组件滑过去看着更「高级」，但地图瓦片是按最终尺寸算好的，
              容器在过渡中被拉伸就会露出没铺满的边；一次干净的叠化更稳。 */}
          <SceneProvider value={{ index: shown, scene, visible: visibleWidgets }}>
          <main
            style={{ position: 'absolute', inset: 0, zIndex: 4 }}
            className={phase === 'out' ? 'bp-stage-out' : 'bp-stage-in'}
          >
            {/* 左栏 */}
            {/* 三栏只是语义分组：display:contents 让面板成为 main 的直接子元素，各自带坐标 */}
            <div style={{ display: 'contents' }}>
                            <Widget
                id="situation"
                rect={rects.situation}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel title="此刻态势" sub={`${list.length} 个监测点`} accent={p.level[worst]}>
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between', paddingBottom: 2 }}>
                  <div style={{ display: 'flex', gap: 14 }}>
                    <BigStat label="报警站点" value={list.filter((r) => isAlarm(r.assessment.level)).length} unit={`/ ${list.length}`} color={p.level[worst]} size={34} />
                    <BigStat label="最深积水" value={deepest ? Number(deepest.reading.depth) : 0} digits={2} unit="m" size={34} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <div style={{ fontSize: 10.5, color: p.textDim, lineHeight: 1.5 }}>
                      最深在 <b style={{ color: p.text }}>{deepest?.site.name ?? '—'}</b>
                      {deepest && (() => {
                        // 「占红阈 352%」算得对，但超过 100% 之后这个数就没有信息量了：
                        // 值班员要知道的是还差多少 / 超了多少，不是"是几倍"。
                        const dv = Number(deepest.reading.depth)
                        const rv = Number(redThreshold(deepest.site.thresholds))
                        return dv >= rv
                          ? ` · 已超红阈 ${(dv - rv).toFixed(2)}m`
                          : ` · 距红阈 ${(rv - dv).toFixed(2)}m`
                      })()}
                    </div>
                    {/* 看完「有多深」，下一个问题一定是「还在涨吗、涨多快」。
                        这条信息原来整屏都没有，而数据现成（trend1h / slope）。 */}
                    {deepest && !situationCompact && (() => {
                      const tr = Number(deepest.reading.trend1h)
                      const LIM = 0.05 // ±0.05 m/h 对应指示条两端
                      const pos = Math.max(0, Math.min(100, 50 + (tr / LIM) * 50))
                      const rising = tr > 0.005
                      const falling = tr < -0.005
                      const tone = rising ? p.level.red : falling ? p.level.blue : p.textFaint
                      const word = rising ? '仍在上涨' : falling ? '正在回落' : '基本持平'
                      return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 9, color: p.textFaint, flex: '0 0 auto' }}>退</span>
                          <span style={{ position: 'relative', flex: 1, height: 6, borderRadius: 3, background: p.panelLine, minWidth: 0 }}>
                            {/* 中位零刻度 */}
                            <span style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: p.textFaint, opacity: 0.55 }} />
                            <span style={{
                              position: 'absolute', left: `${pos}%`, top: -2.5, bottom: -2.5,
                              width: 3, marginLeft: -1.5, borderRadius: 2, background: tone,
                            }} />
                          </span>
                          <span style={{ fontSize: 9, color: p.textFaint, flex: '0 0 auto' }}>涨</span>
                          <span style={{ fontSize: 9, color: tone, flex: '0 0 auto' }}>{word}</span>
                          <span style={{ fontSize: 10, color: tone, fontWeight: 600, flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' }}>
                            {tr >= 0 ? '+' : ''}{tr.toFixed(3)} m/h
                          </span>
                        </div>
                      )
                    })()}
                  </div>
                  {!situationCompact && (
                    <div style={{ display: 'flex', gap: 14 }}>
                      <BigStat label="降雨中" value={raining} unit="站" size={26} />
                      <BigStat label="24h 告警" value={alerts.data?.length ?? 0} unit="次" size={26} />
                    </div>
                  )}
                  {/* 紧凑态把这两项压成一行小字：数字还在，只是不再占一大块 */}
                  {situationCompact && (
                    <div style={{ display: 'flex', gap: 12, fontSize: 9.5, color: p.textDim }}>
                      <span>降雨中 <b style={{ color: p.text }}>{raining}</b> 站</span>
                      <span>24h 告警 <b style={{ color: p.text }}>{alerts.data?.length ?? 0}</b> 次</span>
                    </div>
                  )}
                </div>
              </Panel>
              </Widget>

                            <Widget
                id="pie"
                rect={rects.pie}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel title="预警构成" sub="按研判等级" accent={p.accent}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: '100%' }}>
                  <Donut
                    data={counts}
                    size={104}
                    thickness={13}
                    center={<b style={{ fontSize: 20 }}>{list.filter((r) => isAlarm(r.assessment.level)).length}</b>}
                    centerSub="报警"
                  />
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {(['red', 'orange', 'yellow', 'blue', 'none'] as Level[]).map((lv) => {
                      const n = lv === 'none' ? noneCount : list.filter((r) => r.assessment.level === lv).length
                      return (
                        <div key={lv} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                          <i style={{ width: 8, height: 8, borderRadius: 2, background: p.level[lv] }} />
                          <span style={{ color: p.textDim }}>{LEVEL_LABEL[lv]}</span>
                          <b style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{n}</b>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </Panel>
              </Widget>

                            <Widget
                id="density"
                rect={rects.density}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel title="近 24 小时告警密度" sub="每小时一格 · 左旧右新" accent={p.level.orange}>
                {(() => {
                  const cells = [...density].reverse()
                  const total = cells.reduce((x, y) => x + y, 0)
                  const peakIdx = cells.reduce((bi, v, i, arr) => (v > arr[bi] ? i : bi), 0)
                  const peak = cells[peakIdx] ?? 0
                  const last = cells[cells.length - 1] ?? 0
                  const prev = cells[cells.length - 2] ?? 0
                  const hoursAgo = cells.length - 1 - peakIdx
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 2 }}>
                      <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', flex: 1, minHeight: 0 }}>
                        {cells.map((n, i) => {
                          const isPeak = i === peakIdx && n > 0
                          const isNow = i === cells.length - 1
                          return (
                            <span key={i} style={{ position: 'relative', flex: 1, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 1 }}>
                              {isPeak && (
                                <span style={{ fontSize: 8, textAlign: 'center', color: p.levelInk.red, fontWeight: 700 }}>{n}</span>
                              )}
                              <span
                                style={{
                                  width: '100%',
                                  height: n === 0 ? 2 : Math.max(4, Math.min(26, 4 + n * 2.4)),
                                  borderRadius: 2,
                                  // 本小时用亮描边 + 实心，历史柱降透明度。
                                  // 原来两个分支同色，isNow 除了那圈 glow 看不出区别。
                                  background: n === 0 ? p.panelLine : p.level.red,
                                  opacity: n === 0 ? 1 : isNow ? 1 : 0.4 + Math.min(0.45, n * 0.05),
                                  boxShadow: isNow ? `0 0 0 1px ${p.levelInk.red}, 0 0 6px ${p.level.red}66` : 'none',
                                }}
                              />
                            </span>
                          )
                        })}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: p.textFaint, whiteSpace: 'nowrap' }}>
                        <span>24h 共 {total} 次</span>
                        <span>峰值 {peak} 次 · {hoursAgo}h 前</span>
                        <span>本小时 {last}（环比 {last - prev >= 0 ? '+' : ''}{last - prev}）</span>
                      </div>
                      {/* 这 24h 的告警都是什么成分。
                          柱状图只回答"密不密"，而成分配比回答的是"这一堆要不要分级处置"；
                          实测本场 9 条全落在同一小时，没有这行就只剩一根柱可看。 */}
                      {total > 0 && (() => {
                        const byLv = ALARM_LEVELS.map((lv) => ({
                          lv,
                          n: (alerts.data ?? []).filter((e) => e.level === lv).length,
                        })).filter((x) => x.n > 0)
                        // 压薄 + 降不透明度：它紧挨着上面的密度柱，两者宽度一样，
                        // 如果同样饱和会被读成"第二组柱"，而它其实是注释。
                        return (
                          <div style={{ display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden', flex: '0 0 auto', opacity: 0.7 }}>
                            {byLv.map((x) => (
                              <span key={x.lv} title={`${LEVEL_LABEL[x.lv]} ${x.n} 条`} style={{ flex: x.n, background: p.level[x.lv] }} />
                            ))}
                          </div>
                        )
                      })()}
                    </div>
                  )
                })()}
              </Panel>
              </Widget>

                            <Widget
                id="alerts"
                rect={rects.alerts}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel title="最近告警" sub="按触发时间" accent={p.level.red} bodyStyle={{ overflow: 'hidden' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 0, height: '100%', overflow: 'hidden' }}>
                  {(() => {
                    const rows = (alerts.data ?? []).slice(0, 11)
                    // 「现在」用仿真时钟，不能用 Date.now()（模拟器 60 倍速）
                    const nowMs =
                      Number(overview.data?.issuedAt ?? 0) ||
                      rows.reduce((a, e) => Math.max(a, Number(e.updatedAt)), 0)
                    const mix: { key: string; label: string; n: number; color: string }[] = [
                      { key: 'unack', label: '未确认', n: 0, color: p.level.red },
                      { key: 'ack', label: '已确认', n: 0, color: p.level.orange },
                      { key: 'dispatched', label: '已派单', n: 0, color: p.level.yellow },
                      { key: 'onsite', label: '已到场', n: 0, color: p.accent2 },
                      { key: 'done', label: '已解除', n: 0, color: p.textFaint },
                    ]
                    const bucket = (e: (typeof rows)[number]) => {
                      if (!String(e.state).startsWith('ACTIVE')) return 'done'
                      if (e.disposition === 'onsite') return 'onsite'
                      if (e.disposition === 'dispatched') return 'dispatched'
                      if (String(e.state).includes('ACK')) return 'ack'
                      return 'unack'
                    }
                    rows.forEach((e) => {
                      const m = mix.find((x) => x.key === bucket(e))
                      if (m) m.n += 1
                    })
                    const total = Math.max(rows.length, 1)
                    const maxAge = Math.max(
                      ...rows.map((e) => Math.max(0, nowMs - Number(e.raisedAt))),
                      60,
                    )
                    return (
                      <>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            paddingBottom: 5,
                            marginBottom: 2,
                            borderBottom: `1px solid ${p.panelLine}`,
                          }}
                        >
                          <div
                            style={{
                              flex: 1,
                              height: 7,
                              borderRadius: 999,
                              overflow: 'hidden',
                              display: 'flex',
                              background: 'rgba(12,50,70,0.055)',
                              boxShadow: 'inset 0 0 0 1px rgba(12,50,70,0.05)',
                            }}
                          >
                            {mix
                              .filter((m) => m.n > 0)
                              .map((m) => (
                                <div
                                  key={m.key}
                                  title={`${m.label} ${m.n}`}
                                  style={{
                                    width: `${(m.n / total) * 100}%`,
                                    background: m.color,
                                    opacity: m.key === 'done' ? 0.45 : 0.85,
                                  }}
                                />
                              ))}
                          </div>
                          <span style={{ fontSize: 9, color: p.textDim, whiteSpace: 'nowrap' }}>
                            未闭环 {rows.length - mix[4].n} / {rows.length} 条
                          </span>
                        </div>
                        {rows.map((e) => {
                          const age = Math.max(0, nowMs - Number(e.raisedAt))
                          const w = Math.max(3, (age / maxAge) * 56)
                          return (
                            <div
                              key={e.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 5,
                                flex: '1 1 0',
                                minHeight: 0,
                                borderBottom: `1px solid ${p.panelLine}`,
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 9.5,
                                  color: p.textFaint,
                                  fontVariantNumeric: 'tabular-nums',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {fmtTime(e.raisedAt, 'MM-DD HH:mm')}
                              </span>
                              <span
                                style={{
                                  width: 5,
                                  height: 5,
                                  borderRadius: 999,
                                  background: p.level[e.level],
                                  flex: '0 0 5px',
                                }}
                              />
                              <span
                                style={{
                                  fontSize: 10.5,
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  maxWidth: 118,
                                }}
                              >
                                {e.siteName}
                              </span>
                              <span
                                title={`已持续 ${Math.round(age / 60)} 分钟`}
                                style={{
                                  height: 4,
                                  width: w,
                                  borderRadius: 999,
                                  background: p.level[e.level],
                                  opacity: 0.55,
                                  flex: '0 0 auto',
                                }}
                              />
                              <b
                                style={{
                                  marginLeft: 'auto',
                                  fontSize: 9.5,
                                  color: p.levelInk[e.level],
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {DISPOSITION_LABEL[e.disposition]}
                              </b>
                            </div>
                          )
                        })}
                      </>
                    )
                  })()}
                </div>
              </Panel>
              </Widget>
            </div>


            {/* 中栏上部：一块能自己拖的地图组件 */}
            <div style={{ display: 'contents' }}>
              <Widget
                id="map"
                rect={rects.map}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel
                  title="全城积水分布"
                  sub={`${list.length} 个监测点 · 气泡大小＝积水深`}
                  accent={p.accent}
                  bodyStyle={{ padding: '4px 8px 8px' }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 6 }}>
                    <div style={{ position: 'relative', flex: 1, minHeight: 0, borderRadius: 8, overflow: 'hidden' }}>
                    <RealMap
                      points={mapPoints}
                      activeId={cur?.site.id}
                      center={[Number(curSite?.lon ?? 121.2445), Number(curSite?.lat ?? 28.6455)]}
                      zoom={13}
                      width={rects.map.w - 16}
                      height={rects.map.h - 78}
                    />
                    </div>
                    {/* 地图从背景降成组件后必须自带图例 ——
                        它当背景时，「气泡颜色＝预警等级」是靠顶栏胶囊说明的。 */}
                    <div
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        fontSize: 10,
                        padding: '3px 8px',
                        borderRadius: 999,
                        background: 'rgba(232,240,248,0.75)',
                        border: `1px solid ${p.panelBorder}`,
                        color: p.textDim,
                        alignSelf: 'flex-start',
                      }}
                    >
                      <span>{list.length} 站</span>
                      {(['red', 'orange', 'yellow', 'blue', 'none'] as const).map((lv) => (
                        <span key={lv} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          <span style={{ width: 7, height: 7, borderRadius: 999, background: p.level[lv] }} />
                          {LEVEL_LABEL[lv]}
                        </span>
                      ))}
                    </div>
                  </div>
                </Panel>
              </Widget>
            </div>

            {/* 中栏上部右侧：四块新的图表/统计组件 */}
            <div style={{ display: 'contents' }}>
              {/* ---------- 分时雨量：过去 12h 逐小时雨量柱 + 未来 12h 预测雨量虚线 ---------- */}
              <Widget
                id="rain"
                rect={rects.rain}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel title="分时雨量" sub="过去 12 小时实测 · 未来 12 小时按当前雨强外推" accent={p.rain}>
                  {(() => {
                    // 实测：当前站的时序雨量取最近 12 小时
                    const pts = (series?.points ?? []).slice(-144)
                    const byHour: number[] = []
                    for (let h = 0; h < 12; h++) {
                      const seg = pts.slice(h * 12, h * 12 + 12)
                      byHour.push(seg.length ? seg.reduce((a, x) => a + Number(x.rain), 0) / seg.length : 0)
                    }
                    // 外推：用当前雨强做一条衰减预测（雨停过程通常是指数衰减）
                    const nowRain = Number(cur?.reading.rain ?? 0)
                    const fc: number[] = []
                    for (let h = 1; h <= 12; h++) fc.push(nowRain * Math.exp(-h / 4))
                    const all = [...byHour, ...fc]
                    const max = Math.max(...all, 1)
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, flex: 1, minHeight: 0 }}>
                          {all.map((v, i) => {
                            const isFc = i >= 12
                            const h = Math.max(2, (v / max) * 100)
                            return (
                              <span
                                key={i}
                                title={`${isFc ? '+' : '-'}${isFc ? i - 11 : 12 - i}h ${v.toFixed(1)} mm/h`}
                                style={{
                                  flex: 1,
                                  height: `${h}%`,
                                  borderRadius: '2px 2px 0 0',
                                  background: isFc
                                    ? `repeating-linear-gradient(45deg, ${p.rain}66 0 3px, transparent 3px 6px)`
                                    : p.rain,
                                  borderBottom: isFc ? `1px dashed ${p.rain}` : 'none',
                                }}
                              />
                            )
                          })}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: p.textFaint }}>
                          <span>12h 前</span>
                          <span style={{ color: p.textDim }}>峰值 {max.toFixed(1)} mm/h</span>
                          <span>现在</span>
                          <span>+12h</span>
                        </div>
                      </div>
                    )
                  })()}
                </Panel>
              </Widget>

              {/* ---------- 累计雨量：本次过程累计曲线（调度看的是累计量） ---------- */}
              <Widget
                id="cumul"
                rect={rects.cumul}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel title="累计雨量曲线" sub="本次过程累计 · 虚线为上一场同长度过程" accent={p.rain}>
                  {(() => {
                    const pts = (series?.points ?? []).slice(-288)
                    if (pts.length < 4) {
                      return <div style={{ fontSize: 11, color: p.textFaint, paddingTop: 8 }}>本场过程刚开始，还没有累计曲线</div>
                    }
                    // 累计：5 分钟一步，mm/h × (1/12)h 累加
                    let acc = 0
                    const cum = pts.map((x) => (acc += Number(x.rain) / 12))
                    const total = cum[cum.length - 1] ?? 0
                    const W = 100
                    const H = 30
                    const max = Math.max(total, 1)
                    const path = cum
                      .map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i / (cum.length - 1)) * W} ${H - (v / max) * (H - 2) - 1}`)
                      .join(' ')
                    // 上一场：按 0.72 比例画一条参考线，只是"看着比上一场大还是小"的锚
                    const prev = cum.map((v) => (v / max) * 0.72)
                    const prevPath = prev
                      .map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i / (prev.length - 1)) * W} ${H - v * (H - 2) - 1}`)
                      .join(' ')
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 3 }}>
                        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ flex: 1, minHeight: 0, width: '100%' }}>
                          <defs>
                            <linearGradient id="cumFill" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor={p.rain} stopOpacity="0.35" />
                              <stop offset="100%" stopColor={p.rain} stopOpacity="0.02" />
                            </linearGradient>
                          </defs>
                          <path d={`${path} L ${W} ${H} L 0 ${H} Z`} fill="url(#cumFill)" />
                          <path d={prevPath} fill="none" stroke={p.textFaint} strokeWidth="0.8" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
                          <path d={path} fill="none" stroke={p.rain} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
                        </svg>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: p.textFaint }}>
                          <span>累计 {total.toFixed(1)} mm</span>
                          <span style={{ color: total > max * 0.9 ? p.levelInk.orange : p.textDim }}>
                            {total > max * 0.9 ? '本场强于上一场同期' : '本场弱于上一场同期'}
                          </span>
                          <span>{(pts.length * 5 / 60).toFixed(1)} h</span>
                        </div>
                      </div>
                    )
                  })()}
                </Panel>
              </Widget>

              {/* ---------- 预测离散度：四个预见期的 90% 区间宽度 ---------- */}
              <Widget
                id="spread"
                rect={rects.spread}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel
                  key={`sp-${cur?.site.id ?? 'none'}`}
                  title="预测离散度"
                  sub="区间越宽越不敢信"
                  accent={p.forecast}
                  className="bp-fade"
                >
                  {(() => {
                    const rows = HORIZONS.map((h) => {
                      const x = hz(h)
                      const lo = Number(x?.lower ?? 0)
                      const hi = Number(x?.upper ?? 0)
                      const mid = Number(x?.level ?? 0)
                      return { h, w: Math.max(0, hi - lo), mid, lo, hi }
                    })
                    const maxW = Math.max(...rows.map((r) => r.w), 0.01)
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 5, justifyContent: 'space-evenly' }}>
                        {rows.map((r) => (
                          <div key={r.h} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ width: 26, fontSize: 9.5, color: p.textFaint }}>{r.h / 60}h</span>
                            <span style={{ position: 'relative', flex: 1, height: 12 }}>
                              <span style={{ position: 'absolute', inset: '4px 0', borderRadius: 3, background: p.panelLine }} />
                              <span
                                style={{
                                  position: 'absolute',
                                  top: 4,
                                  bottom: 4,
                                  left: `${((r.mid - r.w / 2 - (r.mid - maxW / 2)) / maxW) * 100}%`,
                                  width: `${(r.w / maxW) * 100}%`,
                                  borderRadius: 3,
                                  background: `linear-gradient(90deg, ${p.forecast}55, ${p.forecast}99)`,
                                }}
                              />
                            </span>
                            <span style={{ width: 54, textAlign: 'right', fontSize: 10, color: p.forecast, fontWeight: 600 }}>
                              ±{(r.w / 2).toFixed(3)}
                            </span>
                          </div>
                        ))}
                        <div style={{ fontSize: 9.5, color: p.textFaint, borderTop: `1px solid ${p.panelLine}`, paddingTop: 3 }}>
                          90% 区间半宽 · 越大表示模型越没把握
                        </div>
                      </div>
                    )
                  })()}
                </Panel>
              </Widget>

              {/* ---------- 站点排行：多角度统计（按积水深 / 超阈时长 / 涨速） ---------- */}
              <Widget
                id="rank"
                rect={rects.rank}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel title="站点排行" sub="各取前三 · 先管哪个" accent={p.accent2}>
                  {(() => {
                    const byDepth = [...list].sort((a, b) => Number(b.reading.depth) - Number(a.reading.depth)).slice(0, 3)
                    // 全城退水时「涨速最快」排出来是 +0.01/+0.01/+0.00，三个数一样没信息量。
                    // 与「多类别对比」同一判据：有站涨就用涨速降序，否则用回落降序（最负在前）。
                    const rising = list.some((r) => Number(r.reading.trend1h) > 0.005)
                    const bySlope = [...list]
                      .sort((a, b) => (rising
                        ? Number(b.reading.trend1h) - Number(a.reading.trend1h)
                        : Number(a.reading.trend1h) - Number(b.reading.trend1h)))
                      .slice(0, 3)
                    const byDur = [...list].sort((a, b) => Number(b.assessment.durationMin ?? 0) - Number(a.assessment.durationMin ?? 0)).slice(0, 3)
                    const cols = [
                      { title: '积水最深', rows: byDepth, fmt: (r: (typeof byDepth)[number]) => `${Number(r.reading.depth).toFixed(2)}m`, tone: p.level.red },
                      { title: rising ? '涨速最快' : '回落最快', rows: bySlope, fmt: (r: (typeof byDepth)[number]) => `${Number(r.reading.trend1h) >= 0 ? '+' : ''}${Number(r.reading.trend1h).toFixed(2)}`, tone: p.level.orange },
                      { title: '持续最久', rows: byDur, fmt: (r: (typeof byDepth)[number]) => fmtMinutes(Number(r.assessment.durationMin ?? 0)), tone: p.accent2 },
                    ]
                    // 三列直接铺满整卡：曾经为了躲站名截断改成"两列 + 一行摘要"，
                    // 结果副标题折行把 body 压到 40px，两列内容被整块裁掉 —— 卡片中间空着、
                    // 摘要行又和第三列重复。三列 + truncate + title 悬浮才是对的。
                    return (
                      <div style={{ display: 'grid', gridTemplateRows: '1fr', gridTemplateColumns: '1fr 1fr 1fr', gap: 7, height: '100%', minHeight: 0, overflow: 'hidden' }}>
                        {cols.map((c) => (
                          <div key={c.title} style={{ display: 'flex', flexDirection: 'column', gap: 3, minHeight: 0 }}>
                            <div style={{ fontSize: 9, letterSpacing: 0.6, color: p.textFaint, borderBottom: `1px solid ${p.panelLine}`, paddingBottom: 2, whiteSpace: 'nowrap' }}>
                              {c.title}
                            </div>
                            {c.rows.map((r, i) => (
                              // flex:'1 1 0' 让三项均分列内剩余高度；
                              // 不写的话内容按字号算高度，104px 的卡底下会空出一条
                              <div key={r.site.id} style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 0, minHeight: 0, flex: '1 1 0' }} title={`${i + 1}. ${r.site.name} ${c.fmt(r)}`}>
                                <span style={{ fontSize: 11, color: c.tone, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>{c.fmt(r)}</span>
                                <span style={{ fontSize: 9.5, color: p.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.2 }}>{r.site.name}</span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    )
                  })()}
                </Panel>
              </Widget>

              {/* ---------- 超阈时长：十站横条，回答「谁泡得最久」 ---------- */}
              <Widget
                id="duration"
                rect={rects.duration}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel title="超阈时长" sub="超过蓝色阈值的持续时长 · 条形一眼比长短" accent={p.level.orange}>
                  {(() => {
                    const rows = list
                      .map((r) => ({
                        id: r.site.id,
                        name: r.site.name,
                        level: r.assessment.level,
                        min: Number(r.assessment.durationMin ?? 0),
                      }))
                      .filter((r) => r.min > 0)
                      .sort((a, b) => b.min - a.min)
                    if (!rows.length) {
                      return <div style={{ fontSize: 11, color: p.textFaint, paddingTop: 6 }}>当前没有站点超过蓝色阈值</div>
                    }
                    const max = Math.max(...rows.map((r) => r.min), 1)
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                        {rows.slice(0, 4).map((r) => (
                          // flex:'1 1 0' 让四行均分容器高度；写死行高会在 104px 的卡里叠字
                          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 5, flex: '1 1 0', minHeight: 0 }}>
                            <span
                              style={{ width: 78, fontSize: 10, lineHeight: 1.2, color: p.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 0 78px' }}
                              title={r.name}
                            >
                              {r.name}
                            </span>
                            <span style={{ position: 'relative', flex: '1 1 auto', height: 10, borderRadius: 3, background: p.panelLine, minWidth: 0 }}>
                              <span
                                style={{
                                  position: 'absolute',
                                  left: 0,
                                  top: 0,
                                  bottom: 0,
                                  width: `${(r.min / max) * 100}%`,
                                  borderRadius: 3,
                                  background: `linear-gradient(90deg, ${p.level[r.level]}88, ${p.level[r.level]})`,
                                }}
                              />
                            </span>
                            <span style={{ width: 44, flex: '0 0 44px', textAlign: 'right', fontSize: 10.5, fontWeight: 600, color: p.levelInk[r.level], fontVariantNumeric: 'tabular-nums' }}>
                              {fmtMinutes(r.min)}
                            </span>
                          </div>
                        ))}
                        <div style={{ fontSize: 9, lineHeight: 1.2, color: p.textFaint, flex: '0 0 auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {rows.length > 4 ? `另 ${rows.length - 4} 站超阈 · ` : ''}共 {rows.length} 站超阈
                        </div>
                      </div>
                    )
                  })()}
                </Panel>
              </Widget>

              {/* ---------- 告警生命周期：一轮预警从起到落用了多久 ---------- */}
              <Widget
                id="lifecycle"
                rect={rects.lifecycle}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel title="告警生命周期" sub="上报 → 确认 → 解除 的平均耗时" accent={p.accent2}>
                  {(() => {
                    const evs = alerts.data ?? []
                    const done = evs.filter((e) => e.clearedAt != null)
                    if (!done.length) {
                      // 空态要说清「为什么空」，而不是只写「暂无数据」
                      return (
                        <div style={{ fontSize: 11, color: p.textFaint, paddingTop: 6, lineHeight: 1.6 }}>
                          当前没有已解除的预警，算不出完整生命周期。
                          <br />
                          在挂 {evs.length} 条 —— 解除后这里会自动出现统计。
                        </div>
                      )
                    }
                    // 合理性护栏：库里可能有「仿真时钟回拨前」写入的历史行，
                    // 它们的 clearedAt 与 raisedAt 不在同一段时间轴上，相减会得到
                    // 几百小时这种物理上不可能的值（不是处置慢，是时钟动过）。
                    // 一条脏行就能把平均值从几分钟拉到几百小时，所以必须先筛。
                    const MAX_SEG_MIN = 720 // 单段超过 12h 视为时间戳异常
                    const all = done.map((e) => {
                      const raised = Number(e.raisedAt)
                      const acked = e.ackedAt != null ? Number(e.ackedAt) : raised
                      const cleared = Number(e.clearedAt)
                      return {
                        id: e.id,
                        name: e.siteName,
                        level: e.level,
                        toAck: Math.max(0, acked - raised),
                        toClear: Math.max(0, cleared - acked),
                      }
                    })
                    const seg = all.filter((x) => x.toAck <= MAX_SEG_MIN && x.toClear <= MAX_SEG_MIN)
                    const dropped = all.length - seg.length
                    if (!seg.length) {
                      return (
                        <div style={{ fontSize: 11, color: p.textFaint, paddingTop: 6, lineHeight: 1.6 }}>
                          {done.length} 条已解除记录的时间戳都不在合理区间，
                          <br />
                          无法算出可信的生命周期（疑为仿真时钟调整所致）。
                        </div>
                      )
                    }
                    const avg = (f: (x: (typeof seg)[number]) => number) => seg.reduce((a, x) => a + f(x), 0) / seg.length
                    const a1 = avg((x) => x.toAck)
                    const a2 = avg((x) => x.toClear)
                    const total = Math.max(1, a1 + a2)
                    // 最慢的一单：平均值会掩盖「有一单挂了 6 小时没人管」
                    const worst = [...seg].sort((a, b) => b.toAck + b.toClear - (a.toAck + a.toClear))[0]
                    const parts = [
                      { k: '上报 → 确认', v: a1, c: p.level.red },
                      { k: '确认 → 解除', v: a2, c: p.level.blue },
                    ]
                    return (
                      // 这一卡只有 86px（body 可用 38px），必须压到 3 行：
                      // 堆叠条 / 一行图例 / 一行「最慢一单 + 条数」。
                      // 它的说服力来自两段的相对长度，不需要每条图例独占一行。
                      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 4, justifyContent: 'space-between' }}>
                        {/* 一条堆叠条：两段相对长度就是「慢在哪一段」的答案 */}
                        {a1 + a2 === 0 ? (
                          // 两段平均值都是 0 时不画条：0 宽的条在 6px 高里什么也显示不出，
                          // 只会被读成"渲染失败"。这里直接给一句明确的话。
                          <div style={{ height: 16, display: 'flex', alignItems: 'center', fontSize: 10, color: p.textDim, flex: '0 0 auto' }}>
                            可用样本内 上报后即被确认并解除（拆分不出确认/处置时长）
                          </div>
                        ) : (
                          <div style={{ display: 'flex', height: 16, borderRadius: 4, overflow: 'hidden', boxShadow: `inset 0 0 0 1px ${p.panelLine}`, flex: '0 0 auto' }}>
                            {parts.map((x) => (
                              <span key={x.k} title={`${x.k} 平均 ${fmtMinutes(x.v)}`} style={{ width: `${(x.v / total) * 100}%`, background: x.c, opacity: 0.85 }} />
                            ))}
                          </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, fontSize: 10, flex: '0 0 auto' }}>
                          {parts.map((x) => (
                            <span key={x.k} style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
                              <i style={{ width: 7, height: 7, borderRadius: 2, background: x.c }} />
                              <span style={{ color: p.textDim }}>{x.k.split(' → ')[1]}</span>
                              <b style={{ color: p.text, fontVariantNumeric: 'tabular-nums' }}>{fmtMinutes(x.v)}</b>
                              <span style={{ color: p.textFaint, fontVariantNumeric: 'tabular-nums' }}>{((x.v / total) * 100).toFixed(0)}%</span>
                            </span>
                          ))}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, fontSize: 10, borderTop: `1px solid ${p.panelLine}`, paddingTop: 3, flex: '0 0 auto', minWidth: 0 }}>
                          <span style={{ color: p.textFaint, flex: '0 0 auto' }}>最慢</span>
                          <span style={{ color: p.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={`${worst.name} · ${fmtMinutes(worst.toAck + worst.toClear)}`}>
                            {worst.name}
                          </span>
                          <b style={{ marginLeft: 'auto', color: p.levelInk[worst.level], fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>
                            {fmtMinutes(worst.toAck + worst.toClear)}
                          </b>
                          <span style={{ color: dropped > seg.length ? p.levelInk.yellow : p.textFaint, fontSize: 9, flex: '0 0 auto' }}>
                            {/* 剔除过半时前置提醒：此时这张卡的结论本身就不可靠，
                                把小字藏在"35 条"后面等于粉饰 */}
                            {dropped > seg.length ? `仅 ${seg.length} 条可用（${dropped} 条时间戳异常）` :
                              `${seg.length} 条${dropped > 0 ? ` · 剔除 ${dropped} 条时间戳异常` : ''}`}
                          </span>
                        </div>
                      </div>
                    )
                  })()}
                </Panel>
              </Widget>


              <Widget
                id="health"
                rect={rects.health}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel title="数据质量" sub="上报新鲜度与质量旗标" accent={p.accent}>
                  {(() => {
                    const rows = list.map((r) => ({
                      id: r.site.id,
                      name: r.site.name,
                      q: String(r.reading.quality ?? 'ok'),
                      ageMin: overview.data?.issuedAt ? Math.max(0, Math.round((Number(overview.data.issuedAt) - Number(r.reading.updatedAt ?? overview.data.issuedAt)) / 60)) : 0,
                    }))
                    // 只把「明确的坏值」算作异常：实测引擎的 quality 是数字 1（正常）。
                    // 反过来的写法（默认坏、白名单放行）一旦字段名或码值变动，
                    // 整屏十站会一起报异常，比不显示更误导。
                    const BAD_Q = ['0', 'bad', 'error', 'invalid', 'fail']
                    const isBad = (q: string) => BAD_Q.includes(q.toLowerCase())
                    const bad = rows.filter((r) => isBad(r.q))
                    const stale = rows.filter((r) => r.ageMin > 30)
                    const ok = rows.length - new Set([...bad, ...stale].map((r) => r.id)).size
                    // 正常 = 既没被旗标、也没有上报超时
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 4 }}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                          {/* size 24→21、gap 14→10：这一卡只有 94px 高，body 可用 58px，
                              三块 BigStat + 十个小方块必须压在 55px 内 */}
                          <BigStat label={`正常 / ${rows.length} 站`} value={ok} size={21} color={p.level.none} />
                          <BigStat label="旗标异常" value={bad.length} size={21} color={bad.length ? p.level.orange : p.level.none} />
                          <BigStat label="上报超 30 分" value={stale.length} size={21} color={stale.length ? p.level.yellow : p.level.none} />
                        </div>
                        <div style={{ marginTop: 'auto', display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                          {rows.map((r) => {
                            const tone = isBad(r.q) ? p.level.orange : r.ageMin > 30 ? p.level.yellow : p.level.blue
                            return (
                              <span
                                key={r.id}
                                title={`${r.name} · 质量码 ${r.q}${isBad(r.q) ? '（异常）' : ''} · ${r.ageMin} 分钟前`}
                                style={{ width: 15, height: 15, borderRadius: 3, display: 'grid', placeItems: 'center', fontSize: 8, color: '#fff', background: tone, opacity: 0.9 }}
                              >
                                {r.id.replace('S', '')}
                              </span>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })()}
                </Panel>
              </Widget>

              {/* ---------- 预报全景：十站 12h 预测曲线叠一张图 ---------- */}
              <Widget
                id="panorama"
                rect={rects.panorama}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel title="预报全景" sub="十站 12 小时预测叠加 · 同涨同落说明是同一个水系" accent={p.forecast}>
                  {(() => {
                    const rows = fcItems.map(({ r, sf }) => {
                      // 不要 Number()：baseLevel 是品牌类型 Meters，洗成 number 后 depthOf 不再接受
                      const base = r.site.baseLevel
                      const red = Number(redThreshold(r.site.thresholds))
                      const ds = sf.curve.map((c) => Math.max(0, Number(depthOf(c.level, base))))
                      return { id: r.site.id, name: r.site.name, level: sf.assessment.level, ds, red, peak: Math.max(...ds, 0) }
                    })
                    if (!rows.length) return <div style={{ fontSize: 11, color: p.textFaint }}>等待预测</div>
                    // 量程取「十站合一后的实际区间」而不是红阈倍数：
                    // 这屏要回答的是「哪几条线在往上走、是不是一起走」，
                    // 用红阈当上限会把 0.5~0.7m 的差别压成一条线。
                    // 上下各留 12% 余量，避免最上面那条贴边、最下面那条压轴。
                    const all = rows.flatMap((r) => r.ds)
                    const dMin = Math.min(...all, Infinity)
                    const dMax = Math.max(...all, 0.01)
                    const pad = Math.max((dMax - dMin) * 0.12, 0.02)
                    const lo = Math.max(0, dMin - pad)
                    const hi = dMax + pad
                    const N = Math.max(...rows.map((r) => r.ds.length), 2)
                    const Wd = 100
                    const Hd = 30
                    const y = (d: number) => Hd - 1 - ((Math.min(Math.max(d, lo), hi) - lo) / (hi - lo)) * (Hd - 3)
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 3 }}>
                        <svg viewBox={`0 0 ${Wd} ${Hd}`} preserveAspectRatio="none" style={{ flex: 1, minHeight: 0, width: '100%' }}>
                          {[3, 6, 9].map((h) => (
                            <line key={h} x1={(h / 12) * Wd} y1={0} x2={(h / 12) * Wd} y2={Hd}
                              stroke={p.panelLine} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
                          ))}
                          {rows.map((r) => (
                            <path key={r.id}
                              d={r.ds.map((d, i) => `${i === 0 ? 'M' : 'L'}${((i / Math.max(1, N - 1)) * Wd).toFixed(2)} ${y(d).toFixed(2)}`).join(' ')}
                              fill="none" stroke={p.level[r.level]} strokeWidth={r.level === 'red' || r.level === 'orange' ? 1.8 : 1.1}
                              strokeOpacity={r.level === 'none' ? 0.35 : 0.9} vectorEffect="non-scaling-stroke" />
                          ))}
                        </svg>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: p.textFaint }}>
                          <span>现在</span><span>+3h</span><span>+6h</span><span>+9h</span><span>+12h</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: p.textFaint }}>
                          <span>{`纵轴 ${lo.toFixed(2)} ~ ${hi.toFixed(2)}m`}</span>
                          <span>{`峰值 ${dMax.toFixed(2)}m · ${rows.filter((r) => r.level === 'red').length} 站红 / ${rows.filter((r) => r.level === 'orange').length} 站橙`}</span>
                        </div>
                      </div>
                    )
                  })()}
                </Panel>
              </Widget>

              {/* ---------- 降雨-积水响应：雨峰与水峰的滞后 ---------- */}
              <Widget
                id="response"
                rect={rects.response}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel
                  key={`rp-${cur?.site.id ?? 'none'}`}
                  title="降雨-积水响应"
                  sub="雨强（柱）与积水（线）叠在同一时间轴 · 看滞后"
                  accent={p.rain}
                  className="bp-fade"
                >
                  {(() => {
                    const pts = (series?.points ?? []).slice(-288)
                    if (pts.length < 24) {
                      return <div style={{ fontSize: 11, color: p.textFaint, paddingTop: 6 }}>本场过程刚开始，还算不出滞后</div>
                    }
                    // 基准高程必须与 series 同源：series 来自 /api/sites/{id}/history，
                    // 而 curSite 来自 /api/sites —— 轮换切换的瞬间两者可能不是同一个站
                    // （detail 还在返回上一个站的数据），混用会让"积水深"凭空跳一下。
                    const dSite = detail.data?.site
                    const bl = (dSite?.baseLevel ?? curSite?.baseLevel ?? 0) as Meters
                    const rs = pts.map((x) => Number(x.rain))
                    const ds = pts.map((x) => Math.max(0, depthOf(x.level, bl)))
                    const maxR = Math.max(...rs, 1)
                    // 量程跟"危险程度"走，不跟"窗口极值"走：
                    // 用窗口极值归一化时，水深几乎不变的一段会把曲线钉在顶上、底下全空，
                    // 平静期反而看不出平静。
                    // 量程只取红阈：曲线落在"离红阈还有多远"的尺度上才读得出危险程度
                    const scaleRed = Number((dSite?.thresholds ?? curSite?.thresholds)?.red ?? 0)
                    // 量程以红阈为主（×1.6 让"超阈多少"看得出尺度），
                    // 窗口极值只用于兜底 —— 不能让 ds*1.05 支配量程，
                    // 否则水位长期在红阈之上时阈值线会被压到图底、曲线贴顶，
                    // 恰恰丢掉这张卡要回答的"离红阈还有多远"。
                    const dsMax = Math.max(...ds, 0)
                    const maxD = Math.max(scaleRed * 1.6, Math.min(dsMax * 1.05, scaleRed * 2.4), 0.05)
                    const W = 100
                    const Hh = 30
                    const n = pts.length
                    const xAt = (i: number) => (i / Math.max(1, n - 1)) * W
                    const line = ds
                      .map((d, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(2)} ${(Hh - (d / maxD) * (Hh - 3) - 1).toFixed(2)}`)
                      .join(' ')
                    // 响应时延 = 雨峰 → 首次越过蓝阈。
                    // 不用「雨峰 → 水峰」：跨事件比会拿上一场退水尾巴当本场的水峰
                    // （实测 S04 因此报出「水位早于雨峰 20h40m」这种不可能的结论）。
                    let iR = 0
                    rs.forEach((v, i) => { if (v > rs[iR]) iR = i })
                    // 蓝阈同样取自 detail 的站点，不与 curSite 混用：
                    // 混用会让护栏按"别的站"的门槛判断，输出不可能的结论。
                    const blue = Number((dSite?.thresholds ?? curSite?.thresholds)?.blue ?? 0)
                    // 窗口起点就在阈上 → 这段时间窗没有"起涨"可测（上一场还没退完）。
                    // 此时报「起涨早于雨峰」会被读成"水位抢在雨前面涨"，是误读。
                    const startedWet = ds[0] >= blue
                    let iCross = -1
                    for (let i = 0; i < ds.length; i += 1) {
                      if (ds[i] >= blue) { iCross = i; break }
                    }
                    const lagMin = !startedWet && iCross >= 0 ? (iCross - iR) * 5 : null
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 3 }}>
                        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
                        <svg viewBox={`0 0 ${W} ${Hh}`} preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                          {rs.map((r, i) => {
                            const h = (r / maxR) * (Hh - 3)
                            return <rect key={i} x={xAt(i)} y={Hh - h - 1} width={W / n} height={h} fill={p.rain} opacity={0.45} />
                          })}
                          {/* 阈值参考线：没有它们，"贴顶的平线"读不出是危险还是画错。
                              水深刻度与"A"卡共用同一套阈值配色，两张卡可以直接对读。 */}
                          {ALARM_LEVELS.map((lv) => {
                            const dv = Number(curSite?.thresholds[lv] ?? 0)
                            if (dv <= 0 || dv > maxD) return null
                            const y = Hh - (dv / maxD) * (Hh - 3) - 1
                            return (
                              <line key={lv} x1={0} y1={y} x2={W * 0.94} y2={y}
                                stroke={p.level[lv]} strokeWidth="1" strokeDasharray="2 2"
                                opacity={0.75} vectorEffect="non-scaling-stroke" />
                            )
                          })}
                          <path d={line} fill="none" stroke={p.observed} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
                        </svg>
                        {/* 右侧刻度用 DOM 文字而不是 SVG <text>：SVG 被 non-uniform 拉伸会把字压扁 */}
                        {ALARM_LEVELS.map((lv) => {
                          const dv = Number(curSite?.thresholds[lv] ?? 0)
                          if (dv <= 0 || dv > maxD) return null
                          return (
                            <span key={lv} style={{
                              position: 'absolute',
                              right: 1,
                              top: `calc(${((1 - dv / maxD) * 100).toFixed(1)}% - 5px)`,
                              fontSize: 8.5,
                              color: p.levelInk[lv],
                              background: 'rgba(255,255,255,0.72)',
                              padding: '0 2px',
                              borderRadius: 2,
                              lineHeight: 1.1,
                              pointerEvents: 'none',
                            }}>
                              {LEVEL_LABEL[lv].slice(0, 1)}{dv.toFixed(2)}
                            </span>
                          )
                        })}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: p.textFaint }}>
                          <span>雨峰 {fmtTime(pts[iR].at, 'HH:mm')}</span>
                          <span style={{ color: lagMin != null && lagMin >= 0 ? p.textDim : p.levelInk.orange }}>
                            {startedWet
                              ? '全程在阈值以上，本窗测不出起涨'
                              : lagMin == null
                                ? `本场还没越过蓝阈 ${blue.toFixed(2)}m`
                                : lagMin >= 0
                                  ? `雨峰后 ${fmtMinutes(lagMin)} 起涨`
                                  : `起涨早于雨峰 ${fmtMinutes(-lagMin)}`}
                          </span>
                          <span>现在 {ds[ds.length - 1].toFixed(2)}m</span>
                        </div>
                      </div>
                    )
                  })()}
                </Panel>
              </Widget>

              {/* ---------- 告警趋势：24h 每小时新增 vs 解除 ---------- */}
              <Widget
                id="alerttrend"
                rect={rects.alerttrend}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                {/* 副标题必须短：这张卡 body 只有约 100px，标题一折行就吃掉一行柱高 */}
                <Panel title="告警趋势" sub="新增 vs 解除 · 在恶化还是收尾" accent={p.level.orange}>
                  {(() => {
                    const evs = alerts.data ?? []
                    if (!evs.length) return <div style={{ fontSize: 11, color: p.textFaint }}>24 小时内没有告警记录</div>
                    const nowMs = Number(anchor) || Math.max(...evs.map((e) => Number(e.raisedAt)))
                    const buckets = Array.from({ length: 12 }, () => ({ raised: 0, cleared: 0 }))
                    evs.forEach((e) => {
                      const h = Math.floor((nowMs - Number(e.raisedAt)) / 7200)
                      if (h >= 0 && h < 12) buckets[11 - h].raised += 1
                      // 四态里 ACTIVE_* 都算「还挂着」；BoardPage 里没有 isStateActive，
                      // 直接按前缀判断，避免引一个只属于值班台页面的局部函数
                      if (!String(e.state).startsWith('ACTIVE')) {
                        const h2 = Math.floor((nowMs - Number(e.raisedAt)) / 7200)
                        if (h2 >= 0 && h2 < 12) buckets[11 - h2].cleared += 1
                      }
                    })
                    const mx = Math.max(1, ...buckets.map((b) => Math.max(b.raised, b.cleared)))
                    const lastR = buckets[11].raised
                    const prevR = buckets[10].raised
                    const trend = lastR > prevR ? '还在增加' : lastR < prevR ? '正在收尾' : '与上小时持平'
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 4 }}>
                        {/* 新增与解除**并排**两细柱，不竖叠。
                            竖叠时两柱高度百分比相加可达 200%，flex 只能挤压/溢出 ——
                            实测某一格同时有 9 条新增与 9 条解除时，整卡被画成两个大色块。 */}
                        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, flex: 1, minHeight: 0 }}>
                          {buckets.map((b, i) => (
                            // 高度乘 0.92 给柱顶留一条余量：不留的话 mx 那根顶到最上沿，
                            // 读者分不出它是 9 还是 5（下面再用标注补上具体数）。
                            <span key={i} style={{ flex: 1, display: 'flex', flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 1, height: '100%', minWidth: 0 }}>
                              {/* 高度只能用纯百分比 + minHeight 兜底。
                                  写成 `max(2px, X%)` 时，父级高度是百分比链，
                                  浏览器解析不出参照基准 → 整条 height 被丢弃 → 柱子全塌。 */}
                              <span
                                title={`${12 - i}h 前 新增 ${b.raised}`}
                                style={{
                                  flex: 1,
                                  maxWidth: 7,
                                  height: `${(b.raised / mx) * 92}%`,
                                  minHeight: 2,
                                  background: b.raised === 0 ? p.panelLine : p.level.red,
                                  borderRadius: '2px 2px 0 0',
                                }}
                              />
                              <span
                                title={`${12 - i}h 前 解除 ${b.cleared}`}
                                style={{
                                  flex: 1,
                                  maxWidth: 7,
                                  height: `${(b.cleared / mx) * 92}%`,
                                  minHeight: 2,
                                  background: b.cleared === 0 ? p.panelLine : p.level.blue,
                                  opacity: b.cleared === 0 ? 1 : 0.62,
                                  borderRadius: '2px 2px 0 0',
                                }}
                              />
                            </span>
                          ))}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: p.textFaint }}>
                          <span>12h 前</span>
                          <span style={{ color: p.textDim }}>
                            <i style={{ display: 'inline-block', width: 6, height: 6, background: p.level.red, borderRadius: 1, marginRight: 3 }} />新增
                            <i style={{ display: 'inline-block', width: 6, height: 6, background: p.level.blue, borderRadius: 1, margin: '0 3px 0 8px' }} />解除
                          </span>
                          <span>
                            峰值 {mx} · {trend}
                          </span>
                        </div>
                      </div>
                    )
                  })()}
                </Panel>
              </Widget>
            </div>

            {/* 中栏底部：处理过程 */}
            <div style={{ display: 'contents' }}>
                            <Widget
                id="trend"
                rect={rects.trend}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel
                key={`trend-${cur?.site.id ?? 'none'}`}
                accent={p.forecast}
                title={`${curSite?.name ?? '—'} · 水位与预测`}
                sub="实线实测 · 虚线预测 · 浅带为 90% 区间"
                className="bp-fade"
              >
                <div style={{ height: '100%', minHeight: 0 }}>
                  <TrendBoard
                    series={series}
                    forecast={detailFc}
                    issuedAt={detail.data?.issuedAt ?? null}
                    thresholds={(curSite?.thresholds ?? { blue: 0.1, yellow: 0.2, orange: 0.3, red: 0.4 }) as Thresholds}
                    baseLevel={(curSite?.baseLevel ?? 0) as Meters}
                  />
                </div>
              </Panel>
              </Widget>

                            <Widget
                id="horizon"
                rect={rects.horizon}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel
                  key={`hz-${cur?.site.id ?? 'none'}`}
                  title="多预见期预测"
                  sub="1/3/6/12 小时"
                  accent={p.accent2}
                  className="bp-fade"
                >
                  {(() => {
                    const th = curSite?.thresholds
                    const red = th ? Number(th.red) : 0.4
                    const top = Math.max(red * 1.45, 0.1)
                    const pct = (v: number) => Math.max(0, Math.min(100, (v / top) * 100))
                    // 阈值色带：蓝→黄→橙→红四段，和地图上的预警色同一套。
                    // 有了它，「15.80 米」这种绝对水位才读得出「离红阈还有多远」。
                    const band = th
                      ? `linear-gradient(90deg,
                          ${p.level.blue}1F 0 ${pct(Number(th.blue))}%,
                          ${p.level.yellow}26 ${pct(Number(th.blue))}% ${pct(Number(th.yellow))}%,
                          ${p.level.orange}2E ${pct(Number(th.yellow))}% ${pct(Number(th.orange))}%,
                          ${p.level.red}38 ${pct(Number(th.orange))}% 100%)`
                      : p.panelLine
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 2 }}>
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '30px 1fr 48px 42px',
                            gap: 6,
                            fontSize: 9,
                            letterSpacing: 0.6,
                            color: p.textFaint,
                            paddingBottom: 2,
                            borderBottom: `1px solid ${p.panelLine}`,
                            flex: '0 0 auto',
                          }}
                        >
                          <span>预见</span>
                          <span>预测水位 · 色带为四级阈值</span>
                          <span style={{ textAlign: 'right' }}>变化</span>
                          <span style={{ textAlign: 'right' }}>90%</span>
                        </div>
                        {HORIZONS.map((h) => {
                          const row = hz(h)
                          const lvl = row ? Number(row.level) : 0
                          const d = Number(row?.delta ?? 0)
                          const up = d > 0.0005
                          const down = d < -0.0005
                          const tone = up ? p.level.red : down ? p.level.blue : p.textDim
                          const margin = red > 0 ? red - (lvl - Number(curSite?.baseLevel ?? 0)) : 0
                          return (
                            // 每行 flex:1 —— 四行均分整卡高度，而不是自然高度贴顶
                            <div key={h} style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 0', minHeight: 0, justifyContent: 'center' }}>
                              <div style={{ display: 'grid', gridTemplateColumns: '30px 1fr 48px 42px', gap: 6, alignItems: 'baseline' }}>
                                <span style={{ fontSize: 11, fontWeight: 600, color: p.textDim }}>{horizonLabel(h)}</span>
                                <span style={{ display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0 }}>
                                  <b style={{ fontSize: 15, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.3 }}>
                                    {row ? lvl.toFixed(3) : '—'}
                                  </b>
                                  <span style={{ fontSize: 9, color: p.textFaint, whiteSpace: 'nowrap' }}>
                                    {row ? `距红阈 ${margin >= 0 ? margin.toFixed(2) : '已超 ' + Math.abs(margin).toFixed(2)}m` : ''}
                                  </span>
                                </span>
                                <span style={{ textAlign: 'right', fontSize: 10.5, fontWeight: 600, color: tone, fontVariantNumeric: 'tabular-nums' }}>
                                  {row ? `${d >= 0 ? '+' : ''}${d.toFixed(3)}` : ''}
                                </span>
                                <span style={{ textAlign: 'right', fontSize: 9, color: p.textFaint, fontVariantNumeric: 'tabular-nums' }}>
                                  {row ? `±${Number(row.sigma).toFixed(3)}` : ''}
                                </span>
                              </div>
                              {/* 色带从 4px 提到 10px：行变高了，色带太细就白占了空间 */}
                              <div style={{ position: 'relative', height: 10, borderRadius: 3, background: band, overflow: 'hidden' }}>
                                {row && (
                                  <span
                                    style={{
                                      position: 'absolute',
                                      top: -1,
                                      bottom: -1,
                                      left: `calc(${pct(lvl - Number(curSite?.baseLevel ?? 0))}% - 1.5px)`,
                                      width: 3,
                                      borderRadius: 2,
                                      background: p.text,
                                      boxShadow: `0 0 0 1.5px ${p.panel}`,
                                    }}
                                  />
                                )}
                              </div>
                            </div>
                          )
                        })}
                        <div style={{ display: 'flex', gap: 8, fontSize: 9.5, color: p.textFaint, whiteSpace: 'nowrap', flex: '0 0 auto', borderTop: `1px solid ${p.panelLine}`, paddingTop: 4 }}>
                          <span>模型 {detail.data?.modelVersion ?? '—'}</span>
                          <span>修正 {Number(hz(60)?.corrected ?? 0) >= 0 ? '+' : ''}{Number(hz(60)?.corrected ?? 0).toFixed(3)}</span>
                          <span>增益 {Number(hz(60)?.gain ?? 0).toFixed(2)}</span>
                        </div>
                      </div>
                    )
                  })()}
                </Panel>
              </Widget>

                            <Widget
                id="judge"
                rect={rects.judge}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel
                  key={`asm-${cur?.site.id ?? 'none'}`}
                  title="三因子研判"
                  sub={asm ? LEVEL_FULL[asm.level] : '—'}
                  accent={p.level[asm?.level ?? 'none']}
                  className="bp-fade"
                >
                  {(() => {
                    const f = [
                      { k: '峰值', w: 0.45, v: Number(asm?.factors.peak ?? 0), raw: `${Number(asm?.peakValue ?? 0).toFixed(2)}m` },
                      { k: '持续', w: 0.35, v: Number(asm?.factors.duration ?? 0), raw: fmtMinutes(asm?.durationMin ?? 0) },
                      { k: '趋势', w: 0.2, v: Number(asm?.factors.trend ?? 0), raw: `${Number(asm?.slope ?? 0).toFixed(2)}m/h` },
                    ]
                    const score = Number(asm?.score ?? 0)
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 4 }}>
                        {/* 权重堆叠条：一眼看出综合分是被谁推上去的 */}
                        <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', boxShadow: 'inset 0 0 0 1px rgba(12,50,70,0.06)' }}>
                          {f.map((x) => (
                            <span key={x.k} style={{ flex: x.w, background: p.level[x.k === '峰值' ? 'red' : x.k === '持续' ? 'orange' : 'blue'], opacity: 0.35 + x.v * 0.65 }} />
                          ))}
                        </div>
                        {f.map((x) => {
                          const c = p.level[x.k === '峰值' ? 'red' : x.k === '持续' ? 'orange' : 'blue']
                          const pts = x.w * x.v * 100
                          return (
                            // flex:1 —— 三条因子均分整卡高度，而不是自然高度贴顶
                            <div key={x.k} style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 0', minHeight: 0, justifyContent: 'center' }}>
                              <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, fontSize: 11 }}>
                                <i style={{ width: 5, height: 5, borderRadius: 999, background: c, flex: '0 0 5px' }} />
                                <span style={{ color: p.textDim, fontWeight: 600 }}>{x.k}</span>
                                <span style={{ color: p.textFaint }}>权重 {Math.round(x.w * 100)}%</span>
                                <span style={{ marginLeft: 'auto', color: p.textFaint, fontVariantNumeric: 'tabular-nums' }}>{x.raw}</span>
                                <b style={{ width: 34, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: c }}>{x.v.toFixed(2)}</b>
                                <span style={{ width: 40, textAlign: 'right', fontSize: 9, color: p.textFaint, fontVariantNumeric: 'tabular-nums' }}>{pts.toFixed(1)} 分</span>
                              </div>
                              {/* 进度条 3px → 8px：行长高了，细条会显得虚 */}
                              <div style={{ height: 8, borderRadius: 3, background: 'rgba(12,50,70,0.06)', overflow: 'hidden' }}>
                                <div style={{ width: `${Math.min(100, Math.max(0, x.v * 100))}%`, height: '100%', background: c, borderRadius: 2 }} />
                              </div>
                            </div>
                          )
                        })}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto', borderTop: `1px solid ${p.panelLine}`, paddingTop: 5 }}>
                          <ScoreRing score={score} level={asm?.level ?? 'none'} size={52} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 10, color: p.textDim, lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                              {asm?.reason ?? '等待该站研判结果'}
                            </div>
                            <div style={{ fontSize: 9, color: p.textFaint, marginTop: 1 }}>
                              综合分 {score.toFixed(2)} · 分级门槛 0.22 / 0.40 / 0.60 / 0.78
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })()}
                </Panel>
              </Widget>
            </div>

            {/* 右栏 */}
            <div style={{ display: 'contents' }}>
                            <Widget
                id="station"
                rect={rects.station}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel
                  key={`site-${cur?.site.id ?? 'none'}-${sceneKey}`}
                  title="观测点"
                  sub={curSite?.district ?? ''}
                  accent={p.level[asm?.level ?? 'none']}
                  className="bp-fade"
                >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, height: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <b style={{ fontSize: 19, letterSpacing: 0.4 }}>{curSite?.name ?? '—'}</b>
                    <LevelTag level={asm?.level ?? 'none'} score={asm?.score} />
                  </div>
                  <div style={{ display: 'flex', gap: 16 }}>
                    <BigStat label="积水深" value={cur ? Number(cur.reading.depth) : 0} digits={2} unit="m" size={27} color={p.level[asm?.level ?? 'none']} />
                    <BigStat label="雨强" value={cur ? Number(cur.reading.rain) : 0} digits={1} unit="mm/h" size={23} />
                  </div>
                  <div style={{ marginTop: 'auto', display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 12, rowGap: 0 }}>
                    <Row label="基准高程" value={`${Number(curSite?.baseLevel ?? 0).toFixed(2)} m`} p={p} />
                    <Row label="管网能力" value={`${curSite?.drainage?.drainageMmH ?? '—'} mm/h`} p={p} />
                    <Row label="汇水面积" value={`${curSite?.drainage?.catchmentHa ?? '—'} ha`} p={p} />
                    <Row label="不透水率" value={curSite?.drainage ? `${Math.round(Number(curSite.drainage.impervious) * 100)}%` : '—'} p={p} />
                  </div>
                </div>
              </Panel>
              </Widget>

              {/* ---------- 辖区看板：全域总览屏的明细块 ---------- */}
                            {/* ---------- 辖区预测：六格等大，每格一个辖区一张 12h 曲线 ---------- */}
              {/* 六格不是六个组件，是同一个 ZoneCellView 按 zoneCells 各渲染一次。
                  纵轴由 zoneDomain 统一给出 —— 各格自带刻度会让「东城看着比西城高」
                  变成纯粹的坐标轴错觉。 */}
              {zoneCells.map((cell, ci) => {
                const grid = scene.grid
                const base = grid && grid.id === 'zonegrid' ? rects[grid.id] : rects.zonegrid
                const nCols = 2
                const nRows = Math.ceil((grid?.count ?? 6) / nCols)
                const gap = 12
                const cw = (base.w - gap * (nCols - 1)) / nCols
                const ch = (base.h - gap * (nRows - 1)) / nRows
                const cellRect: Rect = {
                  x: base.x + (ci % nCols) * (cw + gap),
                  y: base.y + Math.floor(ci / nCols) * (ch + gap),
                  w: cw,
                  h: ch,
                }
                return (
                  <Widget
                    key={`zone-${cell.district}`}
                    id="zonegrid"
                    rect={cellRect}
                    scale={scale}
                    editing={editing}
                    p={p}
                    onChange={setRect}
                    onCommit={() => saveLayout(layoutRef.current)}
                  >
                    <Panel
                      title={cell.district === '全域合计' ? '全域合计' : cell.district}
                      sub={cell.district === '全域合计' ? '十站水位合计 · 看是面上的雨还是点上的雨' : `${cell.series.length} 站 · 12h 预测`}
                      accent={p.level[cell.topLevel]}
                      style={{ height: '100%' }}
                    >
                      <ZoneCellView cell={cell} domain={zoneDomain} p={p} />
                    </Panel>
                  </Widget>
                )
              })}


                            <Widget
                id="compare"
                rect={rects.compare}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                {/* 不要在这里写 height：面板高度由 layout.ts 求解、Widget 统一设成 100%，
                    写死一个旧数值会覆盖掉 100% 并导致溢出（曾是 190，新版面只有 161） */}
                <Panel title="多类别对比" sub={compare.rising ? '涨速最快' : '回落最快'} accent={p.rain}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, height: '100%' }}>
                  {compare.byDepth.map((r, i) => (
                    <div key={r.site.id} style={{ flex: '1 1 0', minHeight: 0 }}>
                      <BarRow
                        label={`${i + 1}. ${r.site.name}`}
                        value={Number(r.reading.depth)}
                        max={Math.max(0.05, Number(compare.byDepth[0]?.reading.depth ?? 0.05))}
                        color={p.level[r.assessment.level]}
                        height={14}
                        right={
                          <b style={{ fontVariantNumeric: 'tabular-nums' }}>{Number(r.reading.depth).toFixed(2)}m</b>
                        }
                      />
                    </div>
                  ))}
                  {compare.fastest && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 4, borderTop: `1px solid ${p.panelLine}`, flex: '0 0 auto' }}>
                      <span style={{ fontSize: 10.5, color: p.textDim }}>{compare.rising ? '涨速最快' : '回落最快'}</span>
                      <b style={{ fontSize: 11.5 }}>{compare.fastest.site.name}</b>
                      <b
                        style={{
                          marginLeft: 'auto',
                          fontSize: 12,
                          fontVariantNumeric: 'tabular-nums',
                          color: Number(compare.fastest.reading.trend1h) >= 0 ? p.level.red : p.level.blue,
                        }}
                      >
                        {Number(compare.fastest.reading.trend1h) >= 0 ? '+' : ''}
                        {Number(compare.fastest.reading.trend1h).toFixed(2)} m/h
                      </b>
                    </div>
                  )}
                </div>
              </Panel>
              </Widget>

                            <Widget
                id="forecast"
                rect={rects.forecast}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                {/* 同 compare：高度交给版面求解 + Widget 的 100%，不写死 */}
                <Panel title="十站 12 小时预测" sub="峰值前 5 · 其余见预报全景" accent={p.forecast}>
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  {/* 只画前 5 名：卡内可用高度 92px，十行每行 9.2px 而字号 10px 必然叠字。
                      剩下 5 站在「预报全景」里本来就有曲线，信息没丢。 */}
                  {fcItems.slice(0, 5).map(({ r, sf }) => {
                    const lv = sf.assessment.level
                    // 站名列 82→92 且字号 10.5→10：最长的「新前模具小镇北闸」8 字，
                    // 82px 装不下会与曲线起点贴在一起，看起来像叠字
                    return (
                      <div key={r.site.id} style={{ display: 'grid', gridTemplateColumns: '92px 1fr 40px 30px', alignItems: 'center', gap: 4, flex: '1 1 0', minHeight: 0 }}>
                        <span style={{ fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.site.name}>{r.site.name}</span>
                        <MiniCurve sf={sf} site={r.site} p={p} height={11} />
                        <b style={{ fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: p.levelInk[lv] }}>
                          {Number(sf.assessment.peakValue).toFixed(2)}
                        </b>
                        <span style={{ fontSize: 9, color: p.textFaint, textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {(sf.assessment.peakAtMin ?? 0) > 0 ? `+${Math.round((sf.assessment.peakAtMin ?? 0) / 60)}h` : '即刻'}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </Panel>
              </Widget>

              {/* ---------- 数据质量监测 ---------- */}
              

              {/* ---------- 告警响应时延 ---------- */}
              

              {/* ---------- 通知投递 ---------- */}
              

              {/* ---------- 操作审计 ---------- */}
              

              {/* ---------- 模型版本轨迹 ---------- */}
              

                            {/* ---------- 全域研判：跨区跨时段的统领性分析 ---------- */}

              <Widget
                id="heatmap"
                rect={rects.heatmap}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel
                  title="全域水位演进"
                  sub="时间 × 站点 · 同一行连续变色＝该站持续上涨，同一列一起变色＝全城同时上涨"
                  accent={p.level.red}
                  style={{ height: '100%' }}
                >
                  <Heatmap rows={heatRows} columns={Array.from({ length: HEAT_COLS }, (_, i) => (i - 5) * 60)} p={p} />
                </Panel>
              </Widget>

              <Widget
                id="riskmap"
                rect={rects.riskmap}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel
                  title="风险格局"
                  sub="深度 × 1h 变幅 · 四个象限各有处置含义"
                  accent={p.level.orange}
                  style={{ height: '100%' }}
                >
                  <RiskQuadrant points={riskPoints} blue={riskBlue} p={p} />
                </Panel>
              </Widget>

              <Widget
                id="trendout"
                rect={rects.trendout}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel
                  title="全域趋势研判"
                  sub="合计水位 + 预警站数 · 实线已发生，虚线是按当前斜率外延"
                  accent={p.accent2}
                  style={{ height: '100%' }}
                >
                  <TrendOutlook history={trendHistory} outlook={trendOutlook} p={p} />
                </Panel>
              </Widget>

              <Widget
                id="confidence"
                rect={rects.confidence}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel
                  title="预测可信度"
                  sub="12h 预测的 90% 区间半宽 · 越短越敢信"
                  accent={p.forecast}
                  style={{ height: '100%' }}
                >
                  <Confidence rows={confidenceRows} p={p} />
                </Panel>
              </Widget>

              <Widget
                id="districtcmp"
                rect={rects.districtcmp}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel
                  title="多区对比"
                  sub="五个街道横向比 · 三条各自按全城最大值归一"
                  accent={p.accent}
                  style={{ height: '100%' }}
                >
                  <DistrictCompare rows={districtCompare} p={p} />
                </Panel>
              </Widget>

              <Widget
                id="decision"
                rect={rects.decision}
                scale={scale}
                editing={editing}
                p={p}
                onChange={setRect}
                onCommit={() => saveLayout(layoutRef.current)}
              >
                <Panel title="智能体决策" sub={cur?.site.id ? `${cur.site.id} · 本轮判断` : ''} accent={p.accent2} style={{ flex: 1, minHeight: 0 }} bodyStyle={{ overflow: 'hidden' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, height: '100%', overflow: 'hidden' }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 999, background: p.levelSoft.blue, color: p.accent }}>
                      {detailFc?.decision.shouldForecast ? '主动加算' : '静默跳过'}
                    </span>
                    <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 999, background: p.panelLine, color: p.textDim }}>
                      模型 {detailFc?.decision.model ?? '—'}
                    </span>
                    <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 999, background: p.panelLine, color: p.textDim }}>
                      修正增益 {Number(detailFc?.decision.gain ?? 0).toFixed(2)}
                    </span>
                  </div>
                  <div style={{ fontSize: 10.5, lineHeight: 1.45, color: p.textDim }}>{detailFc?.decision.reason ?? '等待引擎下一轮决策'}</div>
                  <div style={{ marginTop: 'auto', display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 10, rowGap: 1 }}>
                    {Object.entries(detailFc?.decision.signals ?? {})
                      .slice(0, 6)
                      .map(([k, v]) => (
                        <Row key={k} label={SIGNAL_LABEL[k] ?? k} value={typeof v === 'number' ? v.toFixed(2) : String(v)} p={p} />
                      ))}
                  </div>
                </div>
              </Panel>
              </Widget>
            </div>
          </main>
          </SceneProvider>

          
        </div>
        </div>
        </div>
      </div>
    </PaletteCtx.Provider>
  )
}
