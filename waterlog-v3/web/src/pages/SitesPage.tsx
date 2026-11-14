import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fmtMinutes, LEVEL_LABEL } from '../domain'
import { useTrust } from '../view/useTrust'
import { SORT_LABEL, useWatchlist, type WatchSort } from '../view/useWatchlist'
import { useSituation } from '../view/useSituation'
import { EmptyState, SectionHead } from '../components/primitives/Bits'
import { SiteDrawer } from '../components/interactive/StationDetail'
import { Sparkline } from '../components/primitives/Sparkline'
import { Icon } from '../components/primitives/Icons'
import { DeltaValue, DepthValue, RainValue, ThresholdRuler } from '../components/domain/Value'
import { LevelChip, StatusDot } from '../components/domain/LevelChip'
import { FreshnessBadge, TrustBanner } from '../components/domain/Trust'
import { T } from '../utils/tokens'

const SORTS: readonly WatchSort[] = ['level', 'depth', 'trend', 'rain']

/**
 * 站点列表。和一张图吃的是**同一个视图模型**（`useWatchlist`），只是换了排序和密度。
 *
 * 这里唯一多出来的东西是「排序」。以前一张图的关注清单按等级排、这张表按水深排，
 * 两处的排序各自实现，改了一处另一处就悄悄不一致了。
 */
export function SitesPage() {
  const nav = useNavigate()
  const [sort, setSort] = useState<WatchSort>('level')
  const [selected, setSelected] = useState<string | null>(null)
  const list = useWatchlist(sort)
  const situation = useSituation()
  const trust = useTrust()

  return (
    <div className="space-y-3">
      <TrustBanner
        worst={trust.worst}
        streamOk={trust.streamOk}
        readingAge={trust.readingAge}
        forecastAge={trust.forecastAge}
        hint={trust.hint}
      />

      <div className="card p-4" data-tour="sites-table">
        <SectionHead
          title="全部站点"
          sub={`${list.length} 个监测站点 · 点击任意行就地看详情 · 刻度为四级阈值位置`}
          icon="layers"
          right={
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-ink-3">排序</span>
              <div className="seg">
                {SORTS.map((s) => (
                  <button key={s} className="seg-item" data-active={sort === s} onClick={() => setSort(s)}>
                    {SORT_LABEL[s]}
                  </button>
                ))}
              </div>
            </div>
          }
        />

        {list.length === 0 ? (
          <div className="py-10">
            <EmptyState icon="database" title="还没有站点数据" hint="等第一轮遥测与预测推上来，或到「系统状态」检查引擎。" />
          </div>
        ) : (
          <div className="overflow-x-auto mt-2">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">站点</th>
                  <th className="th">预警</th>
                  <th className="th text-right">实测水位</th>
                  <th className="th text-right">积水深</th>
                  <th className="th">占红阈</th>
                  <th className="th text-right">1h 变化</th>
                  <th className="th text-right">雨量</th>
                  <th className="th">近 3h</th>
                  <th className="th">研判依据</th>
                  <th className="th">数据</th>
                </tr>
              </thead>
              <tbody>
                {list.map((g) => (
                  <tr
                    key={g.site.id}
                    data-site-row={g.site.id}
                    className="row-hover cursor-pointer"
                    onClick={() => setSelected(g.site.id)}
                    style={g.isAlarm ? { background: `${T.levelWeak[g.assessment.level]}66` } : undefined}
                  >
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <StatusDot level={g.assessment.level} />
                        <div className="min-w-0">
                          <div className="text-[13px] font-medium text-ink truncate">{g.site.name}</div>
                          <div className="text-[11px] text-ink-3 num">
                            {g.site.id} · {g.site.district}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="td">
                      <LevelChip level={g.assessment.level} score={g.assessment.score} />
                    </td>
                    <td className="td text-right num text-[12.5px]">{g.reading.level.toFixed(3)}</td>
                    <td className="td text-right">
                      <DepthValue value={g.reading.depth} size="sm" />
                    </td>
                    <td className="td">
                      <div className="w-[104px]">
                        <ThresholdRuler
                          depth={g.reading.depth}
                          thresholds={g.site.thresholds}
                          level={g.assessment.level}
                          height={6}
                        />
                        <div className="text-[10px] text-ink-3 num mt-0.5">
                          红阈 {g.redThreshold.toFixed(2)}m
                        </div>
                      </div>
                    </td>
                    <td className="td text-right">
                      <DeltaValue value={g.reading.trend1h} />
                    </td>
                    <td className="td text-right">
                      <RainValue value={g.reading.rain} />
                    </td>
                    <td className="td">
                      <div className="w-[86px]">
                        <Sparkline data={[...g.reading.spark]} color={T.level[g.assessment.level]} height={24} showLast={false} />
                      </div>
                    </td>
                    <td className="td">
                      <div className="max-w-[300px] text-[11.5px] text-ink-2 leading-snug line-clamp-2">
                        {g.assessment.reason || '—'}
                      </div>
                    </td>
                    <td className="td">
                      <div className="flex flex-col items-start gap-1">
                        <FreshnessBadge freshness={trust.reading} />
                        {g.reading.quality.state !== 'good' && (
                          <span className="text-[10px]" style={{ color: T.levelInk.orange }}>
                            {g.reading.quality.label}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-3">
          <span>占红阈：积水深 / 该站红阈值，刻度依次为蓝、黄、橙、红。</span>
          <span>排序在视图层统一实现，与一张图的关注清单共用同一份口径。</span>
          <span className="num">
            当前最高等级 {LEVEL_LABEL[situation.topLevel]}
            {situation.deepest.siteName !== '—' && ` · 最深 ${situation.deepest.siteName} ${situation.deepest.value.toFixed(2)}m`}
          </span>
        </div>
      </div>

      {/* 行点击开抽屉：右侧就地展开，排序与滚动位置都不丢。
          要整页档案时抽屉里有入口。 */}
      <SiteDrawer
        siteId={selected}
        onClose={() => setSelected(null)}
        onPick={setSelected}
        width={470}
        onOpenArchive={selected ? () => nav(`/sites/${selected}`) : undefined}
      />

      <div className="card p-3 flex flex-wrap items-center gap-4 text-[11px] text-ink-3">
        <span className="flex items-center gap-1.5">
          <Icon name="info" size={13} /> 研判窗口固定为 {list[0] ? fmtMinutes(list[0].assessment.horizonMin) : '3h'} 的预见期
        </span>
        <span>积水深为相对站点基准高程的差值；水位为含基准的绝对高程，跨站点不可直接比较。</span>
      </div>
    </div>
  )
}
