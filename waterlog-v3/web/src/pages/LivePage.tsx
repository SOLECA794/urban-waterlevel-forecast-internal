import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { useOverview } from '../data/queries'
import { LEVEL_FULL, LEVEL_LABEL, type Level } from '../domain'
import { useWatchlist, type SiteGlance } from '../view/useWatchlist'
import { T } from '../utils/tokens'
import { UiIconCmp } from '../components/interactive/UiIcon'
import { Segmented } from '../components/interactive/Segmented'
import { fmtDelta, fmtDepth, SiteDrawer } from '../components/interactive/StationDetail'
import { useToast } from '../components/interactive/Toast'
import { RealMap, type MapLevel, type MapStation } from '../map/RealMap'

/**
 * 一张图 · 应用版。
 *
 * ## 这页和 `/board` 的区别
 *
 * `/board` 是「投在墙上的屏」：自动轮播、不能点、信息一次全铺开。
 * 这一页是「坐在工位上用的工具」：左边选、中间看、右边读细节，
 * 每一步操作都有反馈，状态留在 URL 里，刷新/分享都还原。
 *
 * ## 交互清单（这是重点，不是"顺手加的"）
 *
 * | 交互 | 为什么要有 |
 * |---|---|
 * | 点气泡 → 地图飞过去 + 抽屉滑出 | 大屏上点不了，用户根本不知道那个点在哪条街 |
 * | 点列表行 → 同上，且列表行高亮 | 十站列表是扫读入口，看完名字想去地图上确认位置 |
 * | 抽屉开着时点另一站 → 只换内容不闪 | 逐个对比是常态，关-开-关-开会晕 |
 * | 搜索框 → 站名/街道过滤 | 十个站还好，三十个站就得搜 |
 * | 排序切换 → 列表重排（带动画） | 想知道「谁最深」和「谁涨得最快」是两件事 |
 * | 只看预警 → 过滤列表与地图 | 值班时只想看红的 |
 * | URL `?site=S08` | 刷新还原、能贴给同事 |
 * | 骨架屏 / 空态 / 错误态 | 网络慢的时候不是白屏 |
 * | Esc 关抽屉、可键盘 Tab 到列表 | 键盘用户也要能用 |
 * | 宽度 < 1280 → 抽屉盖满、列表收成抽屉式 | 笔记本外接屏常见 1366 |
 */

type SortKey = 'level' | 'depth' | 'trend' | 'rain'

const SORTS: readonly { value: SortKey; label: string }[] = [
  { value: 'level', label: '等级' },
  { value: 'depth', label: '水深' },
  { value: 'trend', label: '涨速' },
  { value: 'rain', label: '雨强' },
]

// ------------------------------------------------------------------ 列表行

function StationRow({
  g,
  active,
  onPick,
  index,
}: {
  g: SiteGlance
  active: boolean
  onPick: (id: string) => void
  index: number
}) {
  const [hover, setHover] = useState(false)
  const color = T.level[g.assessment.level] ?? T.level.none
  const ink = T.levelInk[g.assessment.level] ?? T.levelInk.none

  return (
    <motion.button
      type="button"
      layout="position"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay: Math.min(index * 0.022, 0.22) }}
      onClick={() => onPick(g.site.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-pressed={active}
      data-site-row={g.site.id}
      data-tour={index === 0 ? 'live-first-row' : undefined}
      style={{
        position: 'relative',
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '9px 10px 9px 12px',
        border: 0,
        borderRadius: 8,
        cursor: 'pointer',
        background: active ? '#FFFFFF' : hover ? 'rgba(255,255,255,0.62)' : 'transparent',
        boxShadow: active ? '0 1px 3px rgba(11,37,69,0.10), 0 0 0 1px rgba(11,37,69,0.07)' : 'none',
        transition: 'background 130ms ease, box-shadow 130ms ease',
      }}
    >
      {/* 左侧等级色条：列表里最快识别"哪几行是红的" */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: 3,
          top: 9,
          bottom: 9,
          width: 3,
          borderRadius: 2,
          background: color,
          opacity: g.assessment.level === 'none' ? 0.42 : 1,
        }}
      />
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: active ? 700 : 600, color: T.text1, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {g.site.name}
        </span>
        <span style={{ fontSize: 15, fontWeight: 700, color: T.text1, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.2 }}>
          {fmtDepth(g.reading.depth)}
        </span>
        <span style={{ fontSize: 10, color: T.text3, marginTop: 1 }}>m</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
        <span style={{ fontSize: 10.5, color: T.text3, width: 34, flexShrink: 0 }}>{g.site.district}</span>
        <span style={{ fontSize: 10.5, fontWeight: 600, color: ink }}>{LEVEL_LABEL[g.assessment.level]}</span>
        <span
          title="近 1 小时水位变化"
          style={{
            fontSize: 10.5,
            marginLeft: 'auto',
            fontVariantNumeric: 'tabular-nums',
            fontWeight: 600,
            color: g.reading.trend1h > 0.02 ? T.levelInk.orange : g.reading.trend1h < -0.02 ? T.levelInk.blue : T.text3,
          }}
        >
          1h {fmtDelta(g.reading.trend1h)}
        </span>
        <span style={{ fontSize: 10.5, color: T.text3, fontVariantNumeric: 'tabular-nums' }}>
          {g.depthRatio > 0 ? `${g.depthRatio.toFixed(2)}×` : '—'}
        </span>
      </div>
      {/* 红阈进度条：0~100% 是一倍红阈，超过就画到头并变红 */}
      <div style={{ marginTop: 5, height: 3, borderRadius: 2, background: '#E3ECF5', overflow: 'hidden' }}>
        <motion.div
          initial={false}
          animate={{ width: `${Math.min(100, g.depthRatio * 100)}%` }}
          transition={{ duration: 0.45, ease: [0.22, 0.61, 0.36, 1] }}
          style={{ height: '100%', background: color, opacity: g.assessment.level === 'none' ? 0.45 : 0.92 }}
        />
      </div>
    </motion.button>
  )
}

// ------------------------------------------------------------------ 页面

export function LivePage() {
  const ov = useOverview()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()

  const [sort, setSort] = useState<SortKey>('level')
  const [query, setQuery] = useState('')
  const [alarmOnly, setAlarmOnly] = useState(false)
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1280)
  const [listOpen, setListOpen] = useState(() => window.innerWidth >= 1280)
  const [mapSettled, setMapSettled] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const selected = params.get('site')
  // 排序口径搬到视图层：页面只声明「按什么排」，怎么排不归页面管。
  // 另外留一份固定按等级排的全量，用于计数、找当前选中站、底部小字——
  // 这些数字不该随用户的表格排序而变。
  const sorted = useWatchlist(sort)
  const all = useWatchlist('level')

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1280)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])


  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = sorted
    if (alarmOnly) list = list.filter((g) => g.isAlarm)
    if (q) {
      list = list.filter(
        (g) => g.site.name.toLowerCase().includes(q) || g.site.district.toLowerCase().includes(q) || g.site.id.toLowerCase().includes(q),
      )
    }
    return list
  }, [sorted, query, alarmOnly])

  const stations = useMemo<MapStation[]>(
    () =>
      filtered.map((g) => ({
        id: g.site.id,
        name: g.site.name,
        district: g.site.district,
        lon: g.site.lon,
        lat: g.site.lat,
        depth: g.reading.depth,
        level: g.assessment.level as MapLevel,
        rain: g.reading.rain,
      })),
    [filtered],
  )

  const alarmCount = all.filter((g) => g.isAlarm).length
  const maxDepth = all.reduce((m, g) => Math.max(m, g.reading.depth), 0)

  const pick = useCallback(
    (id: string) => {
      const g = all.find((x) => x.site.id === id)
      setMapSettled(false)
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set('site', id)
          return next
        },
        { replace: false },
      )
      if (g) toast.info(`${g.site.name} · ${fmtDepth(g.reading.depth)} m`, `${g.site.district} · ${LEVEL_FULL[g.assessment.level]}`)
      if (narrow) setListOpen(false)
    },
    [all, setParams, toast, narrow],
  )

  const closeDrawer = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('site')
        return next
      },
      { replace: true },
    )
  }, [setParams])

  // 键盘：Esc 由 Drawer 处理；这里补一个 "/" 聚焦搜索（地图类应用的习惯）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === '/') {
        e.preventDefault()
        listRef.current?.querySelector<HTMLInputElement>('input')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const sel = selected ? all.find((g) => g.site.id === selected) : null

  return (
    <div style={{ display: 'flex', height: '100%', background: T.bgCanvas, overflow: 'hidden' }}>
      {/* ------------------------------------------------ 左栏：站点列表 */}
      <AnimatePresence initial={false}>
        {listOpen ? (
          <motion.div
            key="list"
            initial={{ x: -300, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -300, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 36 }}
            style={{
              width: narrow ? 268 : 300,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              background: '#F4F8FD',
              borderRight: `1px solid ${T.border1}`,
              position: narrow ? 'absolute' : 'relative',
              top: 0,
              bottom: 0,
              left: 0,
              zIndex: 25,
            }}
          >
            <div style={{ padding: '13px 12px 9px', borderBottom: `1px solid ${T.border2}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 9 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: T.text1, flex: 1 }}>积水监测</span>
                <span style={{ fontSize: 10.5, color: T.text3 }}>
                  {alarmCount}/{all.length} 站预警
                </span>
                {narrow ? (
                  <button type="button" aria-label="收起列表" onClick={() => setListOpen(false)} style={{ width: 24, height: 24, display: 'grid', placeItems: 'center', border: `1px solid ${T.border1}`, borderRadius: 6, background: T.surface, cursor: 'pointer', color: T.text2 }}>
                    <UiIconCmp name="collapse" size={12} />
                  </button>
                ) : null}
              </div>

              <div ref={listRef} style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 9, top: 8, color: T.text3, pointerEvents: 'none' }}>
                  <UiIconCmp name="search" size={13} />
                </span>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜站名、街道（按 / 聚焦）"
                  style={{
                    width: '100%',
                    height: 30,
                    paddingLeft: 28,
                    paddingRight: 8,
                    borderRadius: 7,
                    border: `1px solid ${T.border1}`,
                    background: T.surface,
                    fontSize: 12,
                    color: T.text1,
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 8 }}>
                <Segmented value={sort} options={SORTS} onChange={setSort} size="sm" />
                <button
                  type="button"
                  onClick={() => setAlarmOnly((v) => !v)}
                  aria-pressed={alarmOnly}
                  style={{
                    marginLeft: 'auto',
                    height: 24,
                    padding: '0 8px',
                    borderRadius: 6,
                    border: `1px solid ${alarmOnly ? `${T.level.red}66` : T.border1}`,
                    background: alarmOnly ? T.levelWeak.red : T.surface,
                    color: alarmOnly ? T.levelInk.red : T.text2,
                    fontSize: 11,
                    fontWeight: alarmOnly ? 700 : 500,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  只看预警
                </button>
              </div>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '7px 6px 12px' }}>
              {ov.isLoading ? (
                <div style={{ padding: '4px 6px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <div key={i} style={{ height: 52, borderRadius: 8, background: 'linear-gradient(90deg,#EAEFF6 25%,#F6F9FC 37%,#EAEFF6 63%)', backgroundSize: '400% 100%', animation: 'wl-shimmer 1.35s ease-in-out infinite' }} />
                  ))}
                </div>
              ) : filtered.length === 0 ? (
                <div style={{ padding: '26px 14px', textAlign: 'center' }}>
                  <div style={{ fontSize: 12.5, color: T.text2, lineHeight: 1.65 }}>
                    {query || alarmOnly ? '当前筛选下没有站点' : '还没有站点上报'}
                  </div>
                  {query || alarmOnly ? (
                    <button
                      type="button"
                      onClick={() => {
                        setQuery('')
                        setAlarmOnly(false)
                      }}
                      style={{ marginTop: 10, height: 28, padding: '0 11px', borderRadius: 7, border: `1px solid ${T.border1}`, background: T.surface, cursor: 'pointer', fontSize: 12, color: T.text1, fontWeight: 600 }}
                    >
                      清空筛选
                    </button>
                  ) : null}
                </div>
              ) : (
                <AnimatePresence initial={false}>
                  {filtered.map((g, i) => (
                    <StationRow key={g.site.id} g={g} index={i} active={g.site.id === selected} onPick={pick} />
                  ))}
                </AnimatePresence>
              )}
            </div>

            <div style={{ padding: '8px 12px 10px', borderTop: `1px solid ${T.border2}`, fontSize: 10.5, color: T.text3, lineHeight: 1.6 }}>
              最深 {fmtDepth(maxDepth)} m · 更新时间 {ov.data ? new Date(Number(ov.data.issuedAt) * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—'}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* ------------------------------------------------ 主区：地图 */}
      <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: 52, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', borderBottom: `1px solid ${T.border1}`, background: 'rgba(255,255,255,0.82)', backdropFilter: 'blur(8px)', zIndex: 10 }}>
          {!listOpen ? (
            <button type="button" aria-label="展开站点列表" onClick={() => setListOpen(true)} style={{ width: 28, height: 28, display: 'grid', placeItems: 'center', border: `1px solid ${T.border1}`, borderRadius: 7, background: T.surface, cursor: 'pointer', color: T.text2 }}>
              <UiIconCmp name="expand" size={13} />
            </button>
          ) : null}
          <div style={{ fontSize: 13.5, fontWeight: 700, color: T.text1 }}>黄岩区 · 城市内涝一张图</div>
          <span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 999, background: alarmCount > 0 ? T.levelWeak.red : '#EDF3F9', color: alarmCount > 0 ? T.levelInk.red : T.text3, fontWeight: 600 }}>
            {alarmCount > 0 ? `${alarmCount} 站红色` : '无预警'}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <AnimatePresence>
              {sel && mapSettled ? (
                <motion.span
                  initial={{ opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  style={{ fontSize: 11, color: T.text2, display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <UiIconCmp name="pin" size={12} />
                  已定位 {sel.site.name}
                </motion.span>
              ) : null}
            </AnimatePresence>
            <span style={{ fontSize: 10.5, color: T.text3 }}>拖拽平移 · 滚轮缩放</span>
          </div>
        </div>

        <div style={{ position: 'relative', flex: 1, minHeight: 0, padding: 10 }}>
          <RealMap
            stations={stations}
            focusId={selected}
            onPick={pick}
            height="100%"
            onSettled={() => setMapSettled(true)}
            fitKey={alarmOnly ? 'alarm' : 'all'}
          />

          {/* 图例：浮在地图左下，半透明白底 */}
          <div style={{ position: 'absolute', left: 20, bottom: 20, zIndex: 500, display: 'flex', alignItems: 'center', gap: 9, padding: '5px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.90)', border: `1px solid ${T.border1}`, boxShadow: '0 2px 8px rgba(11,37,69,0.08)' }}>
            {(['blue', 'yellow', 'orange', 'red'] as Level[]).map((lv) => (
              <span key={lv} style={{ display: 'flex', alignItems: 'center', gap: 3.5, fontSize: 10.5, color: T.text2 }}>
                <span style={{ width: 7, height: 7, borderRadius: 999, background: T.level[lv] }} />
                {LEVEL_LABEL[lv]}
              </span>
            ))}
            <span style={{ fontSize: 10, color: T.text3, paddingLeft: 6, borderLeft: `1px solid ${T.border2}` }}>气泡大小 = 积水深</span>
          </div>

          {/* 抽屉：宽度足够时不盖住左栏，只盖住地图右侧。
              实现来自 components/interactive/StationDetail —— 与其它页面同一份。 */}
          <SiteDrawer
            siteId={selected}
            onClose={closeDrawer}
            onPick={pick}
            width={narrow ? undefined : 470}
            onOpenArchive={selected ? () => navigate(`/sites/${selected}`) : undefined}
          />
        </div>
      </div>
    </div>
  )
}
