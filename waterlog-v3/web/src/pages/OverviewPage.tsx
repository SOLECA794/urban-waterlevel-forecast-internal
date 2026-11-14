import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAlerts, useForecast } from '../data/queries'
import { fmtTime, LEVEL_LABEL, maxLevel, type SimTime } from '../domain'
import { useTrust } from '../view/useTrust'
import { MAP_LEGEND } from '../components/charts/MapCanvas'
import { useMapStations } from '../view/useMapPoints'
import { SiteDrawer } from '../components/interactive/StationDetail'
import { RealMap } from '../map/RealMap'
import { nameList, useSituation } from '../view/useSituation'
import { useTopWatch, useWatchlist } from '../view/useWatchlist'
import { EmptyState, Legend, SectionHead, Skeleton, Tracker } from '../components/primitives/Bits'
import { StatCard } from '../components/primitives/Stat'
import { Icon } from '../components/primitives/Icons'
import { TrustBanner } from '../components/domain/Trust'
import { SiteGlanceCard, WatchPanel } from '../components/domain/SiteCards'
import { ForecastStrip } from '../components/domain/ForecastStrip'
import { T } from '../utils/tokens'

/**
 * 一张图。页面只做**布局**：拿四个视图模型，摆到五块区域里。
 *
 *   态势摘要 ← L1（一条结论）
 *   地图     ← L2（空间分布）
 *   计数卡   ← L1 的 counts
 *   站点卡片 ← L3（十行明细）
 *   关注清单 ← L3 的固定切片
 *
 * 页面里不出现 `thresholds[3]`、不出现 `depth / base`、不出现任何排序逻辑——
 * 那些都在视图层，改一次影响所有引用它的页面。
 */
export function OverviewPage() {
  const nav = useNavigate()
  const situation = useSituation()
  const stations = useMapStations()
  const list = useWatchlist('level')
  const top = useTopWatch(5)
  const trust = useTrust()
  const alerts = useAlerts(false)
  const forecast = useForecast()
  // 选中的站点：地图气泡、站点卡、关注清单都能设置它，抽屉是唯一的出口
  const [selected, setSelected] = useState<string | null>(null)

  const issuedAt: SimTime = situation.issuedAt

  // 最近 24 小时（仿真时钟）每小时一格，颜色 = 该小时出现过的最高等级。
  // 用 raised_at 而不是当前状态：问的是「这一小时有没有响过」，不是「现在还响不响」。
  const tracker = (() => {
    const all = alerts.data ?? []
    if (!issuedAt) return []
    return Array.from({ length: 24 }).map((_, i) => {
      const start = issuedAt - (23 - i) * 3600
      const hits = all.filter((a) => a.raisedAt >= start && a.raisedAt < start + 3600)
      return {
        key: String(start),
        label: fmtTime(start as SimTime, 'MM-DD HH:00'),
        level: maxLevel(hits.map((a) => a.level)),
        count: hits.length,
      }
    })
  })()

  const selectedGlance = selected ? (list.find((g) => g.site.id === selected) ?? null) : null

  if (!situation.hasData) {
    return (
      <div className="space-y-4">
        <div className="card p-8">
          <EmptyState
            icon="database"
            title="还没有收到任何遥测数据"
            hint="后端可能刚启动，第一轮预测（每 60 秒一次）还没有推上来。稍等片刻，或到「系统状态」查看引擎是否在跑。"
            action={
              <button className="btn" onClick={() => nav('/system')}>
                去系统状态
              </button>
            }
          />
        </div>
        <div className="grid grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div className="card p-4" key={i}>
              <Skeleton h={10} w="50%" />
              <div className="mt-3">
                <Skeleton h={26} w="40%" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const headline =
    situation.topLevel === 'none'
      ? '全部站点低于蓝色阈值'
      : `${situation.counts.find((c) => c.level === situation.topLevel)?.count ?? 0} 个站点处于${LEVEL_LABEL[situation.topLevel]}预警`
  const topNames = situation.topSites.map((s) => s.name)

  return (
    <div className="space-y-4">
      <TrustBanner
        worst={trust.worst}
        streamOk={trust.streamOk}
        readingAge={trust.readingAge}
        forecastAge={trust.forecastAge}
        hint={trust.hint}
      />

      {/* 态势摘要：一屏之内先给结论，再给证据。
          底色取自最高等级，不用读文字也能看出「现在是红的还是灰的」。 */}
      <div className="card p-0 overflow-hidden" style={{ backgroundImage: T.levelGrad[situation.topLevel] }}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-10 h-10 rounded-[10px] grid place-items-center shrink-0"
              style={{ background: `${T.level[situation.topLevel]}1f`, color: T.levelInk[situation.topLevel] }}
            >
              <Icon name={situation.topLevel === 'none' ? 'shield' : 'alertTriangle'} size={19} />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.12em] text-ink-3">态势摘要</div>
              <div className="text-[15px] font-semibold text-ink truncate">
                {headline}
                {topNames.length > 0 && (
                  <span className="text-ink-2 font-normal"> · 最高 {nameList(topNames)}</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-5 text-[11px] text-ink-2 ml-auto flex-wrap">
            <span className="num">
              积水站点 <b className="text-ink">{situation.alarmCount}</b>/{situation.total}
            </span>
            <span className="num">
              降雨中 <b className="text-ink">{situation.rainingSites}</b>
            </span>
            {/* 各站是独立汇水单元，水深不能相加——这里给的是「最深的那个站」 */}
            <span className="num" title="各站汇水面积不同，水深不能相加">
              最深受水 <b className="text-ink">{situation.deepest.value.toFixed(2)}</b> m
              {situation.deepest.siteName !== '—' && (
                <span className="text-ink-3"> @{situation.deepest.siteName}</span>
              )}
            </span>
            <span className="num hidden xl:inline">
              预测发布于 <b className="text-ink">{fmtTime(issuedAt, 'MM-DD HH:mm')}</b>
            </span>
          </div>
        </div>

        {tracker.length > 0 && (
          <div className="px-4 pb-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-ink-3">最近 24 小时告警活动（仿真时钟，每小时一格）</span>
              <Legend items={MAP_LEGEND} />
            </div>
            <Tracker slots={tracker} height={22} />
          </div>
        )}
      </div>

      {/* 五档计数：footer 直接列出站点名，省掉「点进去看是哪几个」的一跳 */}
      <div className="grid grid-cols-5 gap-3 stagger">
        {(['red', 'orange', 'yellow', 'blue', 'none'] as const).map((lv) => {
          const names = list.filter((g) => g.assessment.level === lv).map((g) => g.site.name)
          const count = situation.counts.find((c) => c.level === lv)?.count ?? 0
          return (
            <StatCard
              key={lv}
              label={LEVEL_LABEL[lv]}
              value={count}
              unit="站"
              tone={lv}
              emphasis={count > 0 && lv !== 'none'}
              footer={names.length ? names.join('、') : lv === 'none' ? '无站点' : '—'}
              onClick={names.length ? () => nav('/sites') : undefined}
            />
          )
        })}
      </div>

      {/* 12 小时预测越阈条带。
          地图答「哪里」、卡片答「现在多深」、关注清单答「凭什么」，
          但原本没有任何一处回答「三小时后哪个站会翻红」——这恰恰是值班最要紧的问题。 */}
      <div className="card card-pad" data-tour="overview-forecast">
        <SectionHead
          title="12 小时预测越阈"
          sub="实心点＝现在 · 三角＝预测峰值 · 虚线斜率＝上涨速度 · 底色为四级阈值分区"
          icon="target"
          right={<span className="text-[11px] text-ink-3">{list.length} 个站点 · 按预测峰值排序</span>}
        />
        <div className="mt-3">
          <ForecastStrip items={list} forecast={forecast.data ?? null} onPick={(id) => nav(`/sites/${id}`)} />
        </div>
      </div>

      <div className="grid grid-cols-[1fr_1fr] gap-4 items-start">
        {/* 地图与关注清单吸顶：右侧十张卡片全展开后页面变长，
            往下翻时地图还在眼前，「哪片区域在报警」和「哪个站点在报警」才能对着看。 */}
        <div className="space-y-4 sticky top-4">
          <div className="card p-4" data-tour="overview-map">
            <SectionHead
              title="站点分布与预警着色"
              sub="真实路网底图 · 可拖拽缩放 · 点气泡看详情"
              icon="map"
              right={
                selectedGlance ? (
                  <span className="text-[11px] num" style={{ color: T.levelInk[selectedGlance.assessment.level] }}>
                    {selectedGlance.site.id} {selectedGlance.site.name} · {selectedGlance.reading.depth.toFixed(3)} m
                  </span>
                ) : (
                  <span className="text-[11px] text-ink-3">{stations.length} 个站点</span>
                )
              }
            />
            <div style={{ height: 400, borderRadius: 8, overflow: 'hidden', border: `1px solid ${T.border1}` }}>
              <RealMap stations={stations} focusId={selected} onPick={setSelected} height="100%" />
            </div>
            <div className="flex items-center justify-between mt-1.5 gap-3">
              <Legend items={MAP_LEGEND} />
              <span className="text-[11px] text-ink-3 shrink-0">气泡大小 = 积水深</span>
            </div>
          </div>

          <WatchPanel items={top} onPick={setSelected} issuedAt={issuedAt} />
        </div>

        {/* 站点卡片列表。
            一开始给的是 max-h-[560px] + overflow-auto，结果第 4 张卡片永远被拦腰截断——
            值班时最想一眼看全的恰恰是「还有哪些站点在报警」，藏在滚动条后面是本末倒置。
            十张卡片全展开，页面长一点没关系。 */}
        <div className="grid grid-cols-2 gap-2.5 stagger">
          {list.map((g) => (
            <SiteGlanceCard key={g.site.id} glance={g} onClick={() => setSelected(g.site.id)} />
          ))}
        </div>
      </div>

      {/* 详情抽屉：任何入口（地图气泡、站点卡、关注清单）都只设置 selected，
          抽屉是唯一出口。这样才不会「这里点开是抽屉、那里点开是跳页」。 */}
      <SiteDrawer
        siteId={selected}
        onClose={() => setSelected(null)}
        onPick={setSelected}
        width={470}
        onOpenArchive={selected ? () => nav(`/sites/${selected}`) : undefined}
      />
    </div>
  )
}
