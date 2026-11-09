import { useMemo } from 'react'
import { curveDepth, fmtMinutes, HORIZONS, LEVEL_SHORT, redThreshold } from '../../domain'
import type { Forecast } from '../../domain'
import type { SiteGlance } from '../../view/useWatchlist'
import { T } from '../../utils/tokens'
import { LevelChip } from '../domain/LevelChip'

/**
 * 全城 12 小时预测曲线条带。
 *
 * 回答「**接下来**会涨到哪一级、还在涨还是已经退了」——值班最要紧、而一张图原本
 * 完全没有回答的问题。原信息结构是：地图答「哪里」、卡片答「现在多深」、
 * 关注清单答「凭什么」，没有一处回答「三个小时后哪几个站会翻红」。
 *
 * 为什么是「每站一条迷你曲线」而不是一张大折线图：十条折线叠在一起五条以上就
 * 分不清谁是谁；拆成十行、每行共享「积水深 → 纵向位置」的映射，横向对得上时间，
 * 于是「谁在涨、谁在退」一眼可比。也不是纯条形图——条形只能给峰值，给不了形状，
 * 而「现在 0.6m 但正在回落」和「现在 0.6m 但两小时后到 0.9m」是完全不同的决策。
 *
 * 底色是该站的四级阈值横带，所以曲线「穿过红带」这件事不需要读数字就能看见。
 */
/**
 * 阈值横带。
 *
 * `y()` 是「深度 → 距顶部像素」，所以色带按「距顶百分比」排列：
 * 红带在 0 到 y(red)，橙带在 y(red) 到 y(orange)……最下面一段是 none。
 * 用 stop 而不是多层 div，是因为多层 div 会互相覆盖。
 */
function bandGradient(
  t: { blue: number; yellow: number; orange: number; red: number },
  y: (d: number) => number,
  height = 24,
): string {
  const at = (d: number) => `${Math.min(100, Math.max(0, (y(d) / height) * 100)).toFixed(2)}%`
  const none = Math.min(100, Math.max(0, (y(t.blue) / height) * 100)).toFixed(2)
  return (
    `linear-gradient(180deg,` +
    `${T.levelWeak.red} 0% ${at(t.red)}%,` +
    `${T.levelWeak.orange} ${at(t.red)}% ${at(t.orange)}%,` +
    `${T.levelWeak.yellow} ${at(t.orange)}% ${at(t.yellow)}%,` +
    `${T.levelWeak.blue} ${at(t.yellow)}% ${none}%,` +
    `${T.levelWeak.none} ${none}% 100%)`
  )
}

export function ForecastStrip({
  items,
  forecast,
  onPick,
}: {
  items: readonly SiteGlance[]
  forecast: Forecast | null
  onPick: (siteId: string) => void
}) {
  const rows = useMemo(() => {
    return items
      .map((g) => {
        const sf = forecast?.sites[g.site.id] ?? null
        const depths = sf ? curveDepth(sf.curve, g.site.baseLevel).map((d) => Math.max(0, d)) : []
        const peak = Math.max(0, g.assessment.peakValue, ...depths)
        const red = redThreshold(g.site.thresholds)
        // 量程要同时放得下红阈值和峰值：各站红阈 0.25~0.50 不等，用固定量程会让
        // 浅站被压成一条线、深站顶到框外。
        const max = Math.max(red * 1.2, peak * 1.08, 0.05)
        return { g, depths, peak, max, red }
      })
      .sort((a, b) => b.peak - a.peak)
  }, [items, forecast])

  if (rows.length === 0) {
    return <div className="py-6 text-center text-[12px] text-ink-3">还没有预测结果</div>
  }

  const spanMin = 720

  return (
    <div>
      {/* 时间刻度只画一次，钉在表头 */}
      <div className="flex items-center gap-2 pb-1">
        <span className="w-[104px] shrink-0 text-[10px] text-ink-3">站点</span>
        <span className="relative flex-1 h-[12px]">
          {[0, 180, 360, 540, 720].map((m) => (
            <span
              key={m}
              className="absolute text-[9.5px] num text-ink-3"
              style={{
                left: `${(m / spanMin) * 100}%`,
                transform: m === 0 ? 'none' : m === spanMin ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {m === 0 ? '现在' : `+${m / 60}h`}
            </span>
          ))}
        </span>
        <span className="w-[58px] shrink-0 text-right text-[10px] text-ink-3">预测峰值</span>
        <span className="w-[44px] shrink-0 text-right text-[10px] text-ink-3">峰值时刻</span>
        <span className="w-[52px] shrink-0" />
      </div>

      <div className="space-y-1">
        {rows.map(({ g, depths, peak, max, red }) => {
          const { site, reading, assessment } = g
          const color = T.level[assessment.level]
          const W = 100
          const H = 24
          const x = (i: number) => (i / Math.max(1, depths.length - 1)) * W
          const y = (d: number) => H - (Math.min(d, max) / max) * H

          // 曲线路径：曲线点本身就是 5 分钟一个，直接连折线即可。
          // 不用平滑插值——这里要读的是「几点几分穿过红带」，平滑会挪动交点。
          const path =
            depths.length > 1
              ? depths.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(d).toFixed(2)}`).join(' ')
              : ''

          // 峰值落点
          const peakIdx = depths.reduce((best, d, i) => (d > depths[best] ? i : best), 0)

          return (
            <button
              key={site.id}
              onClick={() => onPick(site.id)}
              className="flex w-full items-center gap-2 rounded-control px-1.5 py-1 text-left row-hover"
              title={assessment.reason}
            >
              <span className="w-[104px] shrink-0">
                <span className="block truncate text-[11.5px] leading-tight text-ink">{site.name}</span>
                <span className="block text-[9.5px] num leading-tight text-ink-3">
                  {site.id} · 现在 {Math.max(0, reading.depth).toFixed(2)}m
                </span>
              </span>

              <span className="relative flex-1" style={{ height: H }}>
                {/* 四级阈值横带。
                    用一条纵向渐变画，而不是四层绝对定位的 span——
                    四层各自从 top:0 起画，后画的一定盖住先画的，最后只剩最高那一层，
                    看起来就是一片白。渐变 stop 天然不会互相遮挡。 */}
                <span
                  className="absolute inset-0 rounded-[3px]"
                  style={{ background: bandGradient(site.thresholds, y) }}
                />
                {/* 红阈基准线：深色实线，比色带更精确 */}
                <span
                  className="absolute left-0 right-0 h-px"
                  style={{ top: y(red), background: `${T.level.red}66` }}
                />
                {/* 时间网格 */}
                {[180, 360, 540].map((m) => (
                  <span
                    key={m}
                    className="absolute top-0 bottom-0 w-px"
                    style={{ left: `${(m / spanMin) * 100}%`, background: 'rgba(15,23,42,0.06)' }}
                  />
                ))}
                {depths.length > 1 ? (
                  <svg
                    className="absolute inset-0 h-full w-full"
                    viewBox={`0 0 ${W} ${H}`}
                    preserveAspectRatio="none"
                  >
                    <path d={path} fill="none" stroke={color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
                    <circle cx={x(peakIdx)} cy={y(depths[peakIdx])} r={1.8} fill={color} />
                  </svg>
                ) : (
                  <span className="absolute inset-x-0 bottom-0 text-center text-[9px] text-ink-3">无预测</span>
                )}
              </span>

              <span
                className="w-[58px] shrink-0 text-right text-[11px] num"
                style={{ color: T.levelInk[assessment.level] }}
              >
                {peak.toFixed(2)}m
              </span>
              <span className="w-[44px] shrink-0 text-right text-[10px] num text-ink-3">
                {assessment.peakAtMin !== null && assessment.peakAtMin > 0
                  ? fmtMinutes(assessment.peakAtMin)
                  : '即刻'}
              </span>
              <span className="w-[52px] shrink-0 flex justify-end">
                {assessment.level === 'none' ? (
                  <span className="text-[10px] text-ink-3">—</span>
                ) : (
                  <LevelChip level={assessment.level} />
                )}
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-ink-3">
        <span>曲线＝该站在本轮预测里的积水深，5 分钟一个点</span>
        <span>
          底色＝四级阈值横带（{LEVEL_SHORT.blue}/{LEVEL_SHORT.yellow}/{LEVEL_SHORT.orange}/{LEVEL_SHORT.red}）
        </span>
        <span>圆点＝预测峰值</span>
        <span className="ml-auto">
          按预测峰值排序 · {HORIZONS.map((h) => `${h / 60}h`).join(' / ')} 四个预见期取包络
        </span>
      </div>
    </div>
  )
}
