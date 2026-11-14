import { useState } from 'react'
import { Link } from 'react-router-dom'
import { fmtTime, LEVEL_FULL, LEVEL_MEANING, STATE_LABEL, DISPOSITION_LABEL } from '../domain'
import { T } from '../utils/tokens'
import { useSession } from '../view/useSession'
import { ACK_SLA_MIN, ackVerdict, ageText, closureRate, useShiftReport } from '../view/useShiftReport'
import { SectionHead, EmptyState, KeyValue } from '../components/primitives/Bits'
import { StatCard } from '../components/primitives/Stat'
import { Icon } from '../components/primitives/Icons'
import { LevelChip, StatusDot, Tag } from '../components/domain/LevelChip'
import { SiteDrawer } from '../components/interactive/StationDetail'

/**
 * 值班台。
 *
 * 这个页面存在的理由：预警中心按「事件」组织（一条预警一个卷宗），
 * 但交接班时需要的是另一件事——**这 12 小时发生了什么、现在还剩什么没完、
 * 下一班接手要注意什么**。这两件事的数据源相同，组织方式不同。
 *
 * 所以它不重复预警中心的能力（这里不确认、不派单），只做交接：
 * 把「谁该做什么」按紧急程度排好，把「预测靠不靠谱」放在决策者能看到的位置。
 */
export function ShiftPage() {
  const r = useShiftReport()
  const { user } = useSession()
  // 站名点开抽屉。交接时的问题永远是「这一站现在怎么样」，
  // 跳去站点详情会把本班视图的滚动位置和筛选一起丢掉。
  const [siteId, setSiteId] = useState<string | null>(null)

  const rate = closureRate(r)
  const ack = ackVerdict(r)

  return (
    <div className="space-y-4">
      {/* 班次抬头 */}
      <div className="card card-pad">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-[240px] flex-1">
            <div className="eyebrow">交接班</div>
            <h1 className="mt-1 text-[19px] font-semibold text-ink">值班台 · 近 {r.hours} 小时</h1>
            <div className="mt-1 text-[12px] text-ink-2 num">
              {fmtTime(r.from, 'MM-DD HH:mm')} — {fmtTime(r.to, 'HH:mm')}
              <span className="mx-2 text-ink-3">·</span>
              值班人 {user?.displayName ?? '未登录'}
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <div className="text-right">
              <div className="text-[10.5px] text-ink-3">当前最高等级</div>
              <div className="mt-1 flex justify-end">
                {r.worst === 'none' ? (
                  <Tag tone="ok">全城无预警</Tag>
                ) : (
                  <LevelChip level={r.worst} />
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 一句话结论：交接时先看这一行，细节往下翻 */}
        <div
          className="mt-3 rounded-control px-3 py-2 text-[12.5px] leading-relaxed"
          style={{ background: T.levelWeak[r.worst], color: T.levelInk[r.worst] }}
        >
          {r.raised === 0 ? (
            <>
              本班次没有新升起预警，
              {r.active > 0 ? `但仍有 ${r.active} 条激活中的预警需要交出去` : '当前无激活预警'}。
            </>
          ) : (
            <>
              本班次新升起 <b>{r.raised}</b> 条预警，已解除 <b>{r.cleared}</b> 条
              {rate !== null ? `（闭环率 ${(rate * 100).toFixed(0)}%）` : ''}
              {r.todos.length > 0 ? (
                <>
                  ，<b>{r.todos.length} 项需要下一班接手</b>。
                </>
              ) : (
                '，全部已闭环。'
              )}
            </>
          )}
        </div>
      </div>

      {/* 四个数：新增 / 闭环 / 未闭环 / 确认耗时 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 stagger">
        <StatCard
          label="本班新增预警"
          value={r.raised}
          unit="条"
          icon="bell"
          tone="neutral"
          footer={`时间窗 ${fmtTime(r.from, 'HH:mm')} 起`}
        />
        <StatCard
          label="已解除"
          value={r.cleared}
          unit="条"
          icon="check"
          tone={r.cleared > 0 ? 'blue' : 'neutral'}
          footer={rate === null ? '本班无新增' : `闭环率 ${(rate * 100).toFixed(0)}%`}
        />
        <StatCard
          label="未闭环"
          value={r.todos.length}
          unit="项"
          icon="alertTriangle"
          tone={r.todos.some((t) => t.tone === 'critical') ? 'red' : r.todos.length > 0 ? 'yellow' : 'none'}
          footer={
            r.todos.length === 0
              ? `可以正常交接${r.backlog > 0 ? ` · ${r.backlog} 条待归档` : ''}`
              : `${r.todos.filter((t) => t.tone === 'critical').length} 项紧急${
                  r.backlog > 0 ? ` · ${r.backlog} 条待归档` : ''
                }`
          }
        />
        <StatCard
          label="平均确认耗时"
          value={r.avgAckMin ?? '—'}
          unit={r.avgAckMin === null ? undefined : '分钟'}
          icon="clock"
          tone="neutral"
          footer={ack?.text ?? `目标 ${ACK_SLA_MIN} 分钟内确认 · 本班无确认记录`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.25fr_1fr]">
        {/* 交接事项：这一屏是整页的重点 */}
        <div className="card card-pad" data-tour="shift-handoff">
          <SectionHead
            title="交接事项"
            sub="按「预警是否成立 × 处置进度」排列，第一列是下一步动作"
            icon="shield"
            right={
              r.todos.length > 0 ? (
                <Tag tone={r.todos.some((t) => t.tone === 'critical') ? 'danger' : 'warn'}>
                  {r.todos.length} 项
                </Tag>
              ) : (
                <Tag tone="ok">无</Tag>
              )
            }
          />
          {r.todos.length === 0 ? (
            <EmptyState
              icon="check"
              title="没有需要交接的事项"
              hint="仍可到预警中心查看历史事件的完整卷宗"
              compact
            />
          ) : (
            <div className="mt-3 space-y-2">
              {r.todos.slice(0, 12).map((t) => (
                <TodoRow key={t.event.id} todo={t} onPick={setSiteId} />
              ))}
              {r.todos.length > 12 ? (
                <Link
                  to="/alerts"
                  className="block rounded-control border border-dashed py-2 text-center text-[11.5px] text-ink-2 hover:underline"
                  style={{ borderColor: T.borderStrong }}
                >
                  还有 {r.todos.length - 12} 项，去预警中心按时间逐条处理
                </Link>
              ) : null}
              {r.backlog > 0 ? (
                <div className="rounded-control px-2 py-1.5 text-[11px] leading-relaxed text-ink-3" style={{ background: T.levelWeak.none }}>
                  另有 <b className="text-ink-2">{r.backlog} 条</b>预警已解除但没有任何处置记录。
                  它们不需要现在处理，但交接时应当说明——这类事件在复盘时无法回答「当时做了什么」。
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* 本班事件流 */}
        <div className="card card-pad">
          <SectionHead
            title="本班事件流"
            sub="本时间窗内升起的预警，新的在前"
            icon="activity"
            right={<Tag>{r.timeline.length} 条</Tag>}
          />
          {r.timeline.length === 0 ? (
            <EmptyState icon="info" title="本班次没有新预警" hint="时间窗内水位均未触发报警" compact />
          ) : (
            <div className="mt-3 max-h-[420px] space-y-0 overflow-y-auto pr-1 scroll-y">
              {r.timeline.map((e, i) => (
                <div key={e.id} className="relative flex gap-2.5 pb-3">
                  {/* 时间轴线 */}
                  <div className="relative flex w-[14px] shrink-0 justify-center">
                    <span
                      className="absolute top-[9px] bottom-0 w-px"
                      style={{ background: T.border1, display: i === r.timeline.length - 1 ? 'none' : 'block' }}
                    />
                    <span
                      className="relative mt-[5px] h-[7px] w-[7px] rounded-full ring-2"
                      style={{ background: T.level[e.level], boxShadow: `0 0 0 2px ${T.surface}` }}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <button
                        type="button"
                        data-site-name={e.siteId}
                        onClick={() => setSiteId(e.siteId)}
                        title="查看该站点当前水位与预测"
                        className="truncate"
                        style={{
                          border: 0,
                          background: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          fontSize: 12.5,
                          fontWeight: 500,
                          color: T.text1,
                          textDecoration: 'underline',
                          textDecorationColor: T.borderStrong,
                          textUnderlineOffset: 3,
                          maxWidth: 200,
                        }}
                      >
                        {e.siteName}
                      </button>
                      <LevelChip level={e.level} score={e.score} />
                      <span className="ml-auto shrink-0 text-[10.5px] num text-ink-3">
                        {fmtTime(e.raisedAt, 'HH:mm')}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-ink-2">{e.reason}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Tag tone={isStateActive(e.state) ? 'warn' : 'ok'}>{STATE_LABEL[e.state]}</Tag>
                      <Tag>{DISPOSITION_LABEL[e.disposition]}</Tag>
                      {e.assignee ? <span className="text-[10.5px] text-ink-3">{e.assignee}</span> : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 预测质量 + 交接口径 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.4fr]">
        <div className="card card-pad">
          <SectionHead title="这个班的预测靠不靠谱" sub="在线滚动评估，与持久化基线对比" icon="cpu" />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <KeyValue k="样本数" v={r.quality ? `${r.quality.n} 对` : '—'} />
            <KeyValue
              k="skill"
              v={r.quality?.skill != null ? r.quality.skill.toFixed(3) : '—'}
            />
          </div>
          <div className="mt-2.5 text-[11px] leading-relaxed text-ink-3">
            {r.quality === null
              ? '还没有完成结算的预测对，等 3 小时预见期走完才会出现。'
              : (r.quality.skill ?? 0) > 0.3
                ? 'skill 明显为正：模型比「水位不变」的基线更准，可以按预测布防。'
                : (r.quality.skill ?? 0) > 0
                  ? 'skill 略为正：模型仅小幅优于基线，布防应以实测为准。'
                  : 'skill 为负：这段窗口内模型不如「水位不变」基线，交接时不要只信预测。'}
          </div>
        </div>

        <div className="card card-pad">
          <SectionHead title="交接口径" sub="写清楚，下一班才知道这些数字怎么来的" icon="info" />
          <div className="mt-3 space-y-2 text-[11.5px] leading-relaxed text-ink-2">
            <p>
              <b className="text-ink">时间窗</b>用仿真时钟，近 {r.hours} 小时；
              与墙钟不是一回事（模拟器 60 倍速，仿真 1 小时 = 墙钟 1 分钟）。
            </p>
            <p>
              <b className="text-ink">未闭环</b>的判据是两条状态轴取并集：预警仍激活（{LEVEL_FULL.red}
              依然成立就是这一类），或人还在现场（已派单 / 已到场，结果没回填）。
              只看四态会漏掉「已解除但还有人在现场」的那一类；只看处置轴又会漏掉
              「没人管但预警还挂着」的那一类。
            </p>
            <p>
              <b className="text-ink">紧急</b>的定义：已处置但预警仍成立、未派单、或派单超过 30 分钟无人到场。
              这三件事都意味着「水面上的风险没有人在管」。
            </p>
            <p className="text-ink-3">
              当前最高等级 {LEVEL_FULL[r.worst]}——{LEVEL_MEANING[r.worst]}。
            </p>
          </div>
        </div>
      </div>

      <SiteDrawer
        siteId={siteId}
        onClose={() => setSiteId(null)}
        onPick={setSiteId}
        width={470}
      />
    </div>
  )
}

function isStateActive(state: string): boolean {
  return state.startsWith('ACTIVE')
}

function TodoRow({
  todo,
  onPick,
}: {
  todo: ReturnType<typeof useShiftReport>['todos'][number]
  onPick: (id: string) => void
}) {
  const { event: e, tone, action, ageMin, ackMin } = todo
  const color = tone === 'critical' ? T.levelInk.red : tone === 'warn' ? T.levelInk.yellow : T.text3
  const bg = tone === 'critical' ? T.levelWeak.red : tone === 'warn' ? T.levelWeak.yellow : T.levelWeak.none

  return (
    <div className="rounded-control border p-2.5" style={{ borderColor: T.border1, background: bg }}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusDot level={e.level} />
        <button
          type="button"
          data-site-name={e.siteId}
          onClick={() => onPick(e.siteId)}
          title="查看该站点当前水位与预测"
          style={{
            border: 0,
            background: 'none',
            padding: 0,
            cursor: 'pointer',
            fontSize: 12.5,
            fontWeight: 500,
            color: T.text1,
            textDecoration: 'underline',
            textDecorationColor: T.borderStrong,
            textUnderlineOffset: 3,
          }}
        >
          {e.siteName}
        </button>
        <span className="text-[10.5px] num text-ink-3">{e.siteId}</span>
        <LevelChip level={e.level} score={e.score} />
        <span className="text-[10.5px] num" style={{ color: T.text2 }}>
          起于 {ageText(ageMin)}前
        </span>
        {ackMin !== null ? (
          <span className="text-[10.5px] num text-ink-3">确认 {ackMin} 分钟</span>
        ) : (
          <Tag tone="danger">未确认</Tag>
        )}
        <Link
          to="/alerts"
          className="ml-auto flex items-center gap-1 text-[11px] text-primary hover:underline"
        >
          去处置
          <Icon name="chevronRight" size={11} />
        </Link>
      </div>

      <div className="mt-1.5 flex items-start gap-1.5">
        <Icon name="arrowUp" size={12} className="mt-[2px] shrink-0" />
        <span className="text-[12px] font-medium leading-snug" style={{ color }}>
          {action}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-ink-3">
        <span>{STATE_LABEL[e.state]}</span>
        <span>·</span>
        <span>{DISPOSITION_LABEL[e.disposition]}</span>
        {e.assignee ? (
          <>
            <span>·</span>
            <span>负责人 {e.assignee}</span>
          </>
        ) : null}
        {e.noteCount > 0 ? (
          <>
            <span>·</span>
            <span>{e.noteCount} 条备注</span>
          </>
        ) : null}
      </div>
    </div>
  )
}
