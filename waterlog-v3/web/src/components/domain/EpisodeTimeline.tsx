import { fmtMinutes, fmtTime, thresholdSegments } from '../../domain'
import type { Meters, SiteSeries, Thresholds } from '../../domain'
import { T } from '../../utils/tokens'
import { LevelChip } from '../domain/LevelChip'
import { Emph } from '../primitives/Rich'

/**
 * 一次降雨过程的「涨水分段」。
 *
 * 为什么需要它：趋势图回答的是「水位怎么变」，但值班复盘问的是另外三个问题——
 * **这次涨水什么时候开始的、最高到哪一级、超橙持续了多久**。
 * 这三个问题在图上看只能靠估，而且历史窗口里常常有两三段分开的积水过程，
 * 图上连成一片，数不出次数。
 *
 * 数据全部来自 `thresholdSegments`（domain 层的纯函数，只按深度切段），
 * 这里不重新判断等级，也不改判研判结论——研判说「黄」而水深一度到过红，
 * 两者并不矛盾，页面上要能同时看到（横条按水深着色，等级列给研判）。
 */
export function EpisodeTimeline({
  series,
  baseLevel,
  thresholds,
}: {
  series: SiteSeries
  baseLevel: Meters
  thresholds: Thresholds
}) {
  const segs = thresholdSegments(series, baseLevel, thresholds)

  if (series.points.length === 0) {
    return <div className="py-6 text-center text-[12px] text-ink-3">还没有历史数据</div>
  }

  const from = series.points[0].at
  const to = series.points[series.points.length - 1].at
  const span = Math.max(1, to - from)

  if (segs.length === 0) {
    return (
      <div className="py-5 text-center text-[12px] text-ink-3">
        近 {series.hours} 小时没有出现超过蓝色阈值的积水过程
      </div>
    )
  }

  const ongoing = segs.filter((s) => s.ongoing).length

  return (
    <div>
      {/* 时间轴：整段窗口上标出每段积水，空白处就是不积水的时间 */}
      <div className="relative h-[22px] rounded-[4px] overflow-hidden" style={{ background: T.levelWeak.none }}>
        {segs.map((s, i) => (
          <span
            key={i}
            className="absolute top-0 bottom-0"
            style={{
              left: `${((s.start - from) / span) * 100}%`,
              width: `${Math.max(0.4, ((s.end - s.start) / span) * 100)}%`,
              background: T.level[s.level],
              opacity: s.ongoing ? 1 : 0.78,
            }}
            title={`${fmtTime(s.start, 'HH:mm')}–${fmtTime(s.end, 'HH:mm')} · ${fmtMinutes(s.minutes)} · 峰值 ${s.peak.toFixed(2)}m`}
          />
        ))}
        {/* 每 3 小时一条刻线，只画在时间轴上，不做背景网格——底色已经承担了信息 */}
        {Array.from({ length: Math.floor(span / 10800) + 1 }, (_, k) => (
          <span
            key={`t${k}`}
            className="absolute top-0 bottom-0 w-px"
            style={{ left: `${Math.min(100, (k * 10800 / span) * 100)}%`, background: 'rgba(15,23,42,0.10)' }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] num text-ink-3">
        <span>{fmtTime(from, 'HH:mm')}</span>
        <span>{fmtTime(to, 'HH:mm')}</span>
      </div>

      <div className="mt-3 space-y-1">
        {segs.map((s, i) => (
          <div key={i} className="flex items-center gap-2 rounded-control px-1.5 py-1 row-hover">
            <span className="w-[16px] text-[10px] num text-ink-3">{i + 1}</span>
            <span className="w-[104px] text-[11.5px] num text-ink-2">
              {fmtTime(s.start, 'HH:mm')}–{fmtTime(s.end, 'HH:mm')}
            </span>
            <span className="w-[58px] text-[11.5px] num text-ink">{fmtMinutes(s.minutes)}</span>
            <LevelChip level={s.level} />
            <span className="ml-auto text-[11.5px] num" style={{ color: T.levelInk[s.level] }}>
              峰值 {s.peak.toFixed(2)}m
            </span>
            <span
              className="w-[46px] text-right text-[10px]"
              style={{ color: s.ongoing ? T.levelInk.red : T.text3 }}
            >
              {s.ongoing ? '仍在持续' : '已结束'}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-2 text-[10.5px] leading-relaxed text-ink-3">
        共 {segs.length} 段超过蓝色阈值的积水过程{ongoing > 0 ? `，其中 ${ongoing} 段仍在持续` : ''}。
        分段按 5 分钟采样的深度查阈值得到，两段之间只要有任一次采样回落到蓝阈以下就算断开；
        <Emph text="它描述的是**实际过程**，与研判结论（含持续时间门槛与趋势跨档）不是同一件事。" />
      </div>
    </div>
  )
}
