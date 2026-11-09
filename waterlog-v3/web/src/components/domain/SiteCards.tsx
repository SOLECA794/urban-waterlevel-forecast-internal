import {
  fmtMinutes,
  fmtTime,
  isRisingFast,
  LEVEL_LABEL,
  type SimTime,
} from '../../domain'
import type { SiteGlance } from '../../view/useWatchlist'
import { MiniRing } from '../primitives/Gauge'
import { Sparkline } from '../primitives/Sparkline'
import { Icon } from '../primitives/Icons'
import { T } from '../../utils/tokens'
import { DeltaValue, DepthValue, RainValue, ThresholdRuler } from './Value'
import { LevelChip, StatusDot } from './LevelChip'

/**
 * 站点速览卡（L3 明细的展示形态）。
 *
 * 只吃 `SiteGlance`——它已经带好了阈值、比例、是否告警，卡片里不做任何换算。
 * 以前这张卡自己算 `depth / (thresholds[3] || 0.46)`，那个 0.46 是 S01 的红阈值，
 * 套到别的站点上画出来的进度条是错的。
 */
export function SiteGlanceCard({ glance, onClick }: { glance: SiteGlance; onClick: () => void }) {
  const { site, reading, assessment, depthRatio, isAlarm, raining } = glance
  const color = T.level[assessment.level]
  const rising = isRisingFast(reading.trend1h)

  return (
    <button
      onClick={onClick}
      className="card card-hover p-0 overflow-hidden text-left w-full"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-ink truncate">{site.name}</div>
            <div className="text-[11px] text-ink-3 num">
              {site.id} · {site.district}
            </div>
          </div>
          <LevelChip level={assessment.level} score={assessment.score} />
        </div>

        <div className="mt-2 flex items-end gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-1">
              <DepthValue value={reading.depth} size="md" />
              <span className="text-[11px] text-ink-3">积水</span>
              {rising && <Icon name="arrowUp" size={11} className="text-red" />}
            </div>
            <div className="mt-1.5">
              <ThresholdRuler depth={reading.depth} thresholds={site.thresholds} level={assessment.level} height={5} />
            </div>
            <div className="flex items-center justify-between text-[10px] text-ink-3 mt-1 num">
              <span>0</span>
              <span>橙 {site.thresholds.orange.toFixed(2)}</span>
              <span>红 {site.thresholds.red.toFixed(2)}</span>
            </div>
          </div>
          <MiniRing value={depthRatio} color={color} size={40} thickness={4} />
        </div>

        <div className="mt-1.5">
          <Sparkline data={[...reading.spark]} color={color} height={26} area showLast={false} />
        </div>

        <div className="flex items-center justify-between text-[11px] text-ink-3 mt-1.5">
          <RainValue value={reading.rain} />
          <span className="num">
            峰值 {assessment.peakValue.toFixed(2)}m
            {assessment.peakAtMin !== null ? ` @${fmtMinutes(assessment.peakAtMin)}` : ''}
          </span>
          <DeltaValue value={reading.trend1h} />
        </div>

        {isAlarm && (
          <div className="mt-1.5 flex items-center gap-1 text-[10px] text-ink-3">
            <StatusDot level={assessment.level} size={6} />
            {raining ? '雨中' : '雨停'} · {LEVEL_LABEL[assessment.level]} · 综合分{' '}
            <b className="num" style={{ color: T.levelInk[assessment.level] }}>
              {assessment.score.toFixed(2)}
            </b>
          </div>
        )}
      </div>
    </button>
  )
}

/**
 * 值班关注清单：只列「最该看的 N 个」，并在原地给出研判依据原文。
 *
 * 地图回答「哪里」，卡片回答「多深」，这里回答「**凭什么**」——
 * 三件事分开看才不打架。排序口径由 `useTopWatch` 固定（等级→综合分），
 * 不跟随表格排序：这块面板的语义是「不管你在看什么，这五个最该管」。
 */
export function WatchPanel({
  items,
  onPick,
  issuedAt,
}: {
  items: readonly SiteGlance[]
  onPick: (siteId: string) => void
  issuedAt: SimTime
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2">
        <Icon name="bell" size={14} className="text-ink-2" />
        <span className="text-[13px] font-semibold text-ink">值班关注清单</span>
        <span className="text-[11px] text-ink-3">按等级与综合分排序 · 附研判依据</span>
      </div>
      {items.length === 0 ? (
        <div className="mt-2 text-[12px] text-ink-3">当前没有站点达到蓝色阈值，无需处置。</div>
      ) : (
        <div className="mt-2 space-y-1.5">
          {items.map((g) => (
            <button
              key={g.site.id}
              onClick={() => onPick(g.site.id)}
              className="w-full text-left rounded-control px-2 py-1.5 transition-colors"
              style={{ background: T.bgCanvas }}
            >
              <div className="flex items-center gap-2">
                <StatusDot level={g.assessment.level} />
                <span className="text-[12.5px] font-medium text-ink truncate">{g.site.name}</span>
                <LevelChip level={g.assessment.level} score={g.assessment.score} />
                <span className="ml-auto shrink-0">
                  <DepthValue value={g.reading.depth} size="sm" />
                </span>
              </div>
              <div className="text-[11px] text-ink-3 mt-0.5 leading-snug line-clamp-2">
                {g.assessment.reason || '—'}
              </div>
            </button>
          ))}
        </div>
      )}
      <div className="text-[10px] text-ink-3 mt-2 num">
        依据 {issuedAt ? fmtTime(issuedAt, 'MM-DD HH:mm') : '—'} 发布的预测
      </div>
    </div>
  )
}
