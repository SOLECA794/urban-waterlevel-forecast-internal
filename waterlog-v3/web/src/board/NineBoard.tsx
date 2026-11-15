import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { fmtDepth, fmtTime, LEVEL_LABEL, maxLevel } from '../domain'
import { useForecast, useHealth } from '../data/queries'
import { useWatchlist } from '../view/useWatchlist'
import { useSceneRotation } from './useRotation'
import { usePalette } from './theme'
import type { Palette } from './theme'
import { ZOOM_IDS, type ZoomId } from './zoom/types'
import { ZoomChart } from './zoom'

/**
 * 展厅大屏 —— 九页轮播，只讲「水位预测」一件事。
 *
 * ## 为什么另起一页，而不是把旧的三屏改九屏
 *
 * 旧大屏（`BoardPage.tsx`）的三屏讲的是「全域总览 / 辖区预测 / 全域研判」，
 * 里面有三因子研判、预警构成、数据质量、热力图这些面板。评审时的原话是
 * 「你设计的那些什么这因子那维度的全都没用，都是些虚的东西」。
 *
 * 所以这里不是把旧屏加长，而是换一个问题：
 *
 *   水位现在多高 → 接下来会到多高 → 什么时候会翻过红线 → 说得准不准
 *
 * 九页里八页是第 1 页上某一块图的放大，只有第 1 页是「全景」。
 * 观众看第 1 页知道「今天有八件事」，接着八页一件一件讲清楚。
 *
 * 旧大屏保留在 `/board/legacy`（`?page=` 与新页的定屏参数互不干扰），
 * 因为它是「值班常驻」那一套，和展厅讲解不是同一个用途。
 *
 * ## 三条纪律（都是用户逐条打回来的）
 *
 * 1. **图表必须一眼看出在变**。只用四种图：地图气泡、折线、横条、柱状。
 *    它们的长度/高低/直径都跟着数据走。环形占比、雷达、热力、散点全不要——
 *    那几种图的变化肉眼看不出来，投到墙上等于静止画。
 * 2. **每页只有一个主角**。一屏一个大图 + 3~5 个数字。放大页不再加指标，
 *    只把第 1 页那块图里本来就有的东西摊开（见 `zoom/index.tsx`）。
 * 3. **不做交互**。3 秒一页，任何「要点开才看得见」的东西等于不存在。
 *    所以这里没有 hover、没有 tooltip、没有点击展开；只有轮播和它的开关。
 *
 * ## 节奏
 *
 * 第 1 页 5 秒（八块图要扫一遍），其余每页 3 秒。`?page=N` 定屏不推进，
 * 是给截图脚本用的（`scripts/shoot-board9.mjs`）。
 */

const W = 1920
const H = 1080
/** 顶栏高度：品牌、页码、时钟都在这一条里 */
const HEAD = 58
/** 轮播进度条厚度，贴在顶栏下沿 */
const PROG = 3
const PAD = 12
const TOP = HEAD + PROG + 6
const BOTTOM = H - PAD
const CONTENT_H = BOTTOM - TOP
const GAP = 12

/** 第 1 页 KPI 条高度 */
const KPI_H = 92
/** 第 1 页图表区两行的高度（总高要精确等于 CONTENT_H - KPI_H - GAP） */
const ROW1_H = 442
const ROW2_H = CONTENT_H - KPI_H - GAP - ROW1_H - GAP
/** 卡片标题条高度：第 1 页每块图要有名字，否则观众不知道自己在看什么 */
const CARD_HEAD = 28

export interface NinePage {
  key: string
  /** 顶栏上写的问题，一句话，越短越好 */
  title: string
  /** 这一页在回答什么，11px 淡字 */
  sub: string
  durationMs: number
  /** null = 第 1 页（八块 compact），否则是全屏放大的那一块 */
  zoom: ZoomId | null
}

export const NINE_PAGES: readonly NinePage[] = [
  { key: 'overview', title: '水位预测总览', sub: '十站此刻多高 · 接下来会到多高', durationMs: 5000, zoom: null },
  { key: 'zmap', title: '全城积水分布', sub: '气泡直径 = 积水深度 · 十个监测点铺在真实路网上', durationMs: 3000, zoom: 'zmap' },
  { key: 'zlines', title: '十站水位预测', sub: '过去 6 小时实测 + 未来 12 小时预测 · 红线以上是红色预警', durationMs: 3000, zoom: 'zlines' },
  { key: 'zline1', title: '单站水位过程', sub: '最深那一站 · 实线已经发生，虚线还没发生', durationMs: 3000, zoom: 'zline1' },
  { key: 'zpoints', title: '四预见期落点', sub: '1 / 3 / 6 / 12 小时后，各站水位会落到哪一档', durationMs: 3000, zoom: 'zpoints' },
  { key: 'zcross', title: '几点会翻红', sub: '每站预计越过红色预警线的时刻 · 越靠左越急', durationMs: 3000, zoom: 'zcross' },
  { key: 'zacc', title: '预报与实际', sub: '当时说的，和后来真发生的，差多少', durationMs: 3000, zoom: 'zacc' },
  { key: 'zrank', title: '积水程度排行', sub: '先派谁去', durationMs: 3000, zoom: 'zrank' },
  { key: 'zrain', title: '雨还在下吗', sub: '过去每小时下了多少 · 这是水位的源头', durationMs: 3000, zoom: 'zrain' },
]

/**
 * 第 1 页八块图的坐标。手写而不是按权重算：
 * 这八块的宽高比各自有天然比例（地图要方、排行要宽而矮、四预见期要方），
 * 用统一权重分出来反而是每一块都不合适。改这里只改数字，不动渲染逻辑。
 *
 * 四列两行，宽度和精确等于 1896（=1920 - 2×12），间隙 12：
 *   行 1：600 + 520 + 460 + 280 + 3×12 = 1896
 *   行 2：420 + 560 + 400 + 480 + 3×12 = 1896
 */
const GRID: readonly { id: ZoomId; x: number; y: number; w: number; h: number }[] = [
  { id: 'zmap', x: PAD, y: 0, w: 600, h: ROW1_H },
  { id: 'zlines', x: PAD + 600 + GAP, y: 0, w: 520, h: ROW1_H },
  { id: 'zline1', x: PAD + 600 + GAP + 520 + GAP, y: 0, w: 460, h: ROW1_H },
  { id: 'zpoints', x: PAD + 600 + GAP + 520 + GAP + 460 + GAP, y: 0, w: 280, h: ROW1_H },
  { id: 'zrank', x: PAD, y: ROW1_H + GAP, w: 420, h: ROW2_H },
  { id: 'zcross', x: PAD + 420 + GAP, y: ROW1_H + GAP, w: 560, h: ROW2_H },
  { id: 'zacc', x: PAD + 420 + GAP + 560 + GAP, y: ROW1_H + GAP, w: 400, h: ROW2_H },
  { id: 'zrain', x: PAD + 420 + GAP + 560 + GAP + 400 + GAP, y: ROW1_H + GAP, w: 480, h: ROW2_H },
]

/** 第 1 页每块图的标题，与 `WIDGET_TITLE` 保持同一套说法 */
const GRID_TITLE: Record<ZoomId, string> = {
  zmap: '全城积水分布',
  zlines: '十站水位预测',
  zline1: '单站水位过程',
  zpoints: '四预见期落点',
  zcross: '几点会翻红',
  zacc: '预报与实际',
  zrank: '积水程度排行',
  zrain: '雨还在下吗',
}

function useStageScale() {
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const apply = () => setScale(Math.min(window.innerWidth / W, window.innerHeight / H))
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])
  return scale
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReduced(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

/** 第 1 页的卡片外壳：一块底 + 一行标题。图表本身由 zoom 组件画。 */
function Card({ title, p, x, y, w, h, children }: { title: string; p: Palette; x: number; y: number; w: number; h: number; children: ReactNode }) {
  return (
    <div
      data-zoom-card=""
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        display: 'flex',
        flexDirection: 'column',
        background: p.panel,
        border: `1px solid ${p.panelBorder}`,
        borderRadius: 10,
        boxShadow: p.elev[1],
        overflow: 'hidden',
      }}
    >
      <div style={{ height: CARD_HEAD, display: 'flex', alignItems: 'center', padding: '0 12px', borderBottom: `1px solid ${p.panelLine}`, flex: '0 0 auto' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: p.text, letterSpacing: 0.3 }}>{title}</span>
      </div>
      <div style={{ flex: '1 1 0', minHeight: 0, padding: 8 }}>{children}</div>
    </div>
  )
}

/** 一句话数字：KPI 条里四块都用它，避免四套排版。 */
function Kpi({ label, value, unit, note, tone, p }: { label: string; value: string; unit?: string; note: string; tone: string; p: Palette }) {
  return (
    <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 18px', borderLeft: `3px solid ${tone}` }}>
      <span style={{ fontSize: 11, color: p.textFaint, letterSpacing: 1 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, marginTop: 2 }}>
        <span style={{ fontSize: 34, fontWeight: 800, lineHeight: 1.05, color: tone, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        {unit ? <span style={{ fontSize: 13, color: p.textDim }}>{unit}</span> : null}
      </div>
      <span style={{ fontSize: 11, color: p.textDim, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{note}</span>
    </div>
  )
}

export function NineBoard() {
  const p = usePalette()
  const reduced = useReducedMotion()
  const scale = useStageScale()

  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const locked = params.get('page') != null
  const initial = useMemo(() => {
    const raw = params.get('page')
    const n = raw == null ? NaN : Number(raw)
    return Number.isFinite(n) && n >= 0 && n < NINE_PAGES.length ? n : 0
  }, [params])

  const carousel = useSceneRotation({
    count: NINE_PAGES.length,
    durationMs: (i) => NINE_PAGES[i]?.durationMs ?? 3000,
    locked,
    initial,
  })

  const page = NINE_PAGES[carousel.index] ?? NINE_PAGES[0]

  // 数据只在最外层拉一次，九页共用。每页各自 useQuery 也能靠 react-query 去重，
  // 但外层拿到的这几项要用于顶栏与 KPI，重复订阅只会让「顶栏数」与「图里数」
  // 有可能来自不同时刻的两份快照 —— 这个项目已经三次栽在这上面。
  const list = useWatchlist('level')
  const forecast = useForecast()
  const health = useHealth()

  const alarmCount = list.filter((g) => g.isAlarm).length
  const raining = list.filter((g) => g.raining).length
  const deepest = list[0]
  const worst = maxLevel(list.map((g) => g.assessment.level))

  /** 1 小时后最严重的那一站：从十站的四档预测里取 1h 档的最大水深。 */
  const next1h = useMemo(() => {
    const sites = forecast.data?.sites ?? {}
    let best: { name: string; depth: number } | null = null
    for (const g of list) {
      const sf = sites[g.site.id]
      const h0 = sf?.horizons?.[0]
      if (!h0) continue
      const d = Number(h0.level) - Number(g.site.baseLevel)
      if (!Number.isFinite(d)) continue
      if (!best || d > best.depth) best = { name: g.site.name, depth: d }
    }
    return best
  }, [forecast.data, list])

  const maxRain = useMemo(() => list.reduce((m, g) => Math.max(m, Number(g.reading.rain) || 0), 0), [list])
  const now = health.data?.now

  const stageIn = reduced ? undefined : 'nb-in 420ms cubic-bezier(0.22,0.61,0.36,1) both'

  return (
    <div
      data-board="nine"
      data-page={carousel.index}
      data-page-key={page.key}
      style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: p.bg1, color: p.text, fontFamily: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif' }}
    >
      <style>{`
        @keyframes nb-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        @keyframes nb-progress { from { transform: scaleX(0); } to { transform: scaleX(1); } }
        @keyframes nb-live { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
        .nb-live { animation: nb-live 1.6s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .nb-live { animation: none; }
        }
      `}</style>

      {/* 画布：1920×1080 定尺，整体按较小比例缩放，保证一块面板都不被裁 */}
      <div style={{ position: 'absolute', left: '50%', top: '50%', width: W, height: H, transform: `translate(-50%, -50%) scale(${scale})`, transformOrigin: 'center center' }}>
        {/* ---------------------------------------------------------- 顶栏 */}
        <header
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            height: HEAD,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '0 16px',
            background: `linear-gradient(90deg, ${p.panel} 0%, ${p.bg2} 100%)`,
            borderBottom: `1px solid ${p.panelBorder}`,
            zIndex: 8,
          }}
        >
          <div style={{ width: 34, height: 34, borderRadius: 9, background: `linear-gradient(135deg, ${p.accent}, ${p.accent2})`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 15, fontWeight: 800 }}>涝</div>
          <div style={{ lineHeight: 1.1 }}>
            <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: 0.5 }}>台州市黄岩区</div>
            <div style={{ fontSize: 10, color: p.textFaint, letterSpacing: 2.6, marginTop: 2 }}>城市内涝监测预警</div>
          </div>

          {/* 这一页在回答什么问题：放大页没有卡片框，标题只能挂在顶栏，
              否则投到墙上观众不知道「这一屏那张大图说的是哪句话」。 */}
          <div style={{ marginLeft: 18, display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
            <span style={{ fontSize: 21, fontWeight: 800, color: p.text, whiteSpace: 'nowrap' }}>{page.title}</span>
            <span style={{ fontSize: 11.5, color: p.textDim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 560 }}>{page.sub}</span>
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            {worst !== 'none' ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 11px', borderRadius: 999, background: `${p.level[worst]}22`, border: `1px solid ${p.level[worst]}88`, color: p.levelInk[worst], fontSize: 12, fontWeight: 700 }}>
                <i className="nb-live" style={{ width: 7, height: 7, borderRadius: 999, background: p.level[worst], display: 'inline-block' }} />
                {alarmCount} 站 {LEVEL_LABEL[worst]}
              </span>
            ) : (
              <span style={{ fontSize: 12, color: p.textDim }}>十站全部低于预警线</span>
            )}
            <span style={{ fontSize: 13, color: p.textDim, fontVariantNumeric: 'tabular-nums' }}>{now ? fmtTime(now, 'MM-DD HH:mm:ss') : '—'}</span>
            <button
              onClick={carousel.togglePlay}
              aria-label={carousel.playing ? '暂停轮播' : '继续轮播'}
              title={carousel.playing ? '暂停轮播' : '继续轮播'}
              style={{ width: 26, height: 26, borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${p.panelBorder}`, background: 'transparent', color: p.textDim, padding: 0 }}
            >
              {carousel.playing ? (
                <span style={{ display: 'inline-flex', gap: 3 }}>
                  <i style={{ width: 3, height: 11, background: 'currentColor', borderRadius: 1 }} />
                  <i style={{ width: 3, height: 11, background: 'currentColor', borderRadius: 1 }} />
                </span>
              ) : (
                <span style={{ width: 0, height: 0, borderTop: '6px solid transparent', borderBottom: '6px solid transparent', borderLeft: '9px solid currentColor', marginLeft: 2 }} />
              )}
            </button>
            <span style={{ fontSize: 11, color: p.textFaint, fontVariantNumeric: 'tabular-nums', letterSpacing: 1 }}>
              {carousel.index + 1}/{NINE_PAGES.length}
            </span>
          </div>
        </header>

        {/* 轮播进度：整条按当前页时长推进。key 换页即重启动画，
            不逐帧 setState —— 1920×1080 的整棵树每帧重渲染会掉帧。 */}
        <div style={{ position: 'absolute', left: 0, right: 0, top: HEAD, height: PROG, zIndex: 9, background: 'rgba(12,60,90,0.08)', pointerEvents: 'none' }}>
          <div
            key={`nb-pg-${carousel.index}`}
            style={{
              height: '100%',
              width: '100%',
              transformOrigin: 'left center',
              transform: 'scaleX(0)',
              background: `linear-gradient(90deg, ${p.accent}, ${p.accent2})`,
              animation: `nb-progress ${page.durationMs}ms linear forwards`,
              animationPlayState: carousel.playing ? 'running' : 'paused',
            }}
          />
        </div>

        {/* ---------------------------------------------------------- 舞台 */}
        <main key={page.key} style={{ position: 'absolute', inset: 0, animation: stageIn }}>
          {page.zoom == null ? (
            <>
              {/* KPI 条：四块数字。全部来自同一份 `list` / `forecast` 快照 */}
              <div
                data-kpi=""
                style={{ position: 'absolute', left: PAD, top: TOP, width: W - PAD * 2, height: KPI_H, display: 'flex', alignItems: 'stretch', background: p.panel, border: `1px solid ${p.panelBorder}`, borderRadius: 10, boxShadow: p.elev[1], overflow: 'hidden' }}
              >
                <Kpi label="红色预警" value={String(alarmCount)} unit={`/ ${list.length} 站`} note={alarmCount > 0 ? '已越过红色阈值' : '目前没有站越过红线'} tone={alarmCount > 0 ? p.level.red : p.level.none} p={p} />
                <Kpi label="当前最深积水" value={deepest ? fmtDepth(deepest.reading.depth) : '0.00'} unit="m" note={deepest ? deepest.site.name : '—'} tone={deepest ? p.level[deepest.assessment.level] : p.level.none} p={p} />
                <Kpi label="1 小时后" value={next1h ? fmtDepth(next1h.depth) : '—'} unit="m" note={next1h ? `预测最深 · ${next1h.name}` : '这一档没有发布结果'} tone={p.forecast} p={p} />
                <Kpi label="当前雨强" value={maxRain.toFixed(1)} unit="mm/h" note={`正在下雨 ${raining} 站 · 最大站雨强`} tone={p.rain} p={p} />
              </div>

              {/* 八块图。compact 尺寸，逐块独立成卡 */}
              {GRID.map((c) => (
                <Card key={c.id} title={GRID_TITLE[c.id]} p={p} x={c.x} y={TOP + KPI_H + GAP + c.y} w={c.w} h={c.h}>
                  <ZoomChart id={c.id} p={p} w={c.w - 16} h={c.h - CARD_HEAD - 16} detail="compact" />
                </Card>
              ))}
            </>
          ) : (
            <div style={{ position: 'absolute', left: PAD, top: TOP, width: W - PAD * 2, height: CONTENT_H }}>
              <ZoomChart id={page.zoom} p={p} w={W - PAD * 2} h={CONTENT_H} detail="full" />
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

/** 供脚本与文档核对：九页的 key 顺序与 `NINE_PAGES` 一致 */
export const NINE_PAGE_KEYS = NINE_PAGES.map((s) => s.key)
export const NINE_ZOOM_KEYS = ZOOM_IDS
