import { useMemo } from 'react'
import { useAlerts, useHealth, useOverview } from '../data/queries'
import { useLive } from '../data/live'
import { fmtClock, isActive, LEVEL_LABEL, type Level } from '../domain'
import { useSession } from '../view/useSession'
import { useSituation } from '../view/useSituation'
import { useShiftReport } from '../view/useShiftReport'
import { useTrust } from '../view/useTrust'
import { W, BAR_H, RAIL_W, DRILL_W, ease } from './visual'
import { startTour } from '../components/TourHost'
import type { Stage } from './model'

/**
 * 顶部事实条。
 *
 * 它的作用不是「导航」，而是**把全屏最要紧的四件事钉在视线最上方**：
 * 现在多严重、还剩几件没完、在用什么模型、链路通不通。
 *
 * 这四件事同时也是这一屏的入口——点「4 站红色」看全域态势，点「还剩 3 项」
 * 看本班交接，点模型版本号看可信度，点链路灯看哪一层断了。
 * 这样屏幕上就不需要一条标签栏：**看得见的事实本身就是入口**。
 */
export function FactBar({
  stage,
  onStage,
}: {
  stage: Stage
  onStage: (s: Stage) => void
}) {
  const session = useSession()
  const sit = useSituation()
  const shift = useShiftReport()
  const trust = useTrust()
  const health = useHealth()
  const live = useLive()
  const ov = useOverview()
  const alerts = useAlerts(false)

  const openTodos = useMemo(() => shift.todos.length, [shift.todos])

  const activeCount = useMemo(
    () => (alerts.data ?? []).filter((a) => isActive(a.state)).length,
    [alerts.data],
  )

  // 标签本身已经是「模型」，值只写状态，否则顶栏会念成「模型 模型在线」。
  const modelState = ov.data?.rows.length
    ? health.data?.engineOk
      ? '在线'
      : '离线'
    : '无数据'

  const counts = sit.counts
  const red = counts.find((c) => c.level === 'red')?.count ?? 0
  const orange = counts.find((c) => c.level === 'orange')?.count ?? 0

  return (
    <div
      data-tour="wb-facts"
      style={{
        height: BAR_H,
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        padding: `0 ${DRILL_W > 0 ? 16 : 16}px 0 14px`,
        background: W.bar,
        color: W.barInk,
        fontFamily: W.sans,
      }}
    >
      {/* 品牌 + 一句话态势。这段话是整屏的「结论行」，用自然语言而不是数字堆叠。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: RAIL_W - 14 }}>
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            background: 'linear-gradient(145deg, #1B94B8, #0B6E8C)',
            display: 'grid',
            placeItems: 'center',
            fontSize: 11,
            fontWeight: 700,
            color: '#fff',
            flex: '0 0 auto',
          }}
        >
          涝
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: 0.3 }}>城区内涝研判</span>
      </div>

      {/* 结论句：不用看数字也知道现在什么状况。 */}
      <button
        type="button"
        onClick={() => onStage({ kind: 'situation' })}
        data-fact="situation"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 10px',
          marginRight: 6,
          borderRadius: 6,
          border: `1px solid ${stage.kind === 'situation' ? '#2C5C7C' : 'transparent'}`,
          background: stage.kind === 'situation' ? '#1A3F5C' : 'transparent',
          color: W.barInk,
          cursor: 'pointer',
          font: 'inherit',
          transition: `background 160ms ${ease}`,
        }}
        title="全域态势（当前屏幕默认状态）"
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            background: red > 0 ? W.level.red : orange > 0 ? W.level.orange : W.level.none,
            boxShadow: red > 0 ? `0 0 0 3px ${W.level.red}44` : 'none',
            flex: '0 0 auto',
          }}
        />
        <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {sit.hasData
            ? red > 0 || orange > 0
              ? `全域 ${LEVEL_LABEL[sit.topLevel as Level]} · ${red + orange} 站高危`
              : sit.alarmCount > 0
                ? `全域 ${LEVEL_LABEL[sit.topLevel as Level]} · ${sit.alarmCount} 站预警`
                : '全域无预警'
            : '等待数据'}
        </span>
      </button>

      {/* 三个入口：未闭环事项 / 模型 / 链路。都是「屏幕上写着的事实」。 */}
      <Fact
        label="待办"
        value={openTodos}
        unit="项"
        tone={openTodos > 0 ? '#F5B84A' : undefined}
        active={stage.kind === 'handoff'}
        factKey="handoff"
        onClick={() => onStage({ kind: 'handoff' })}
        title="本班 12 小时内升起、还没闭环的预警（点开看交接清单）"
      />

      <Fact
        label="激活中"
        value={activeCount}
        unit="条"
        tone={activeCount > 0 ? '#F5B84A' : undefined}
        title="四态里所有 ACTIVE 的预警条数，含已确认与未确认"
      />

      <Fact
        label="模型"
        value={modelState}
        mono={false}
        active={stage.kind === 'trust'}
        factKey="trust"
        onClick={() => onStage({ kind: 'trust' })}
        title="点开看离线指标、在线滚动与版本治理"
      />

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* 链路灯：绿=实测与预测都新鲜；黄=有一头滞后；红=断。 */}
        <button
          type="button"
          onClick={() => onStage({ kind: 'plumbing' })}
          data-fact="plumbing"
          title={`链路：实测 ${trust.label} · ${trust.hint}（点开看四层分别哪一层断了）`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 9px',
            borderRadius: 12,
            border: `1px solid ${trust.worst === 'live' ? '#1E6B52' : trust.worst === 'stalled' ? '#8A3030' : '#6B5A22'}`,
            background: trust.worst === 'live' ? '#14453A' : trust.worst === 'stalled' ? '#4A1D1D' : '#3D3418',
            color: W.barInk,
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              background: trust.worst === 'live' ? '#34D399' : trust.worst === 'stalled' ? '#F87171' : '#FBBF24',
            }}
          />
          <span style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{trust.label}</span>
          <span style={{ fontSize: 10, color: W.barInkDim }}>
            SSE {live.connected ? '通' : '断'}
          </span>
        </button>

        {/* 仿真时刻。它是全屏唯一的「现在」，所有相对时间都以它为准。 */}
        <span
          style={{
            fontSize: 11,
            color: W.barInkDim,
            fontFamily: W.mono,
            fontVariantNumeric: 'tabular-nums',
            minWidth: 96,
            textAlign: 'right',
          }}
          title="系统仿真时钟（不是本机时间）"
        >
          {health.data?.now ? fmtClock(health.data.now) : '—'}
        </span>

        {/* 大屏是「把这一屏放到大厅去」，是个操作而不是一块内容，
            所以放在顶栏右侧和「治理」并列，不占事实位。 */}
        <button
          type="button"
          onClick={() => onStage({ kind: 'wall' })}
          data-fact="wall"
          title="无交互轮换展示，适合常驻大厅屏幕（点开后按 Esc 或点出口回来）"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 24,
            // 不给固定宽度：中文两字塞进 26px 圆里会竖排成两列
            padding: '0 9px',
            borderRadius: 12,
            border: `1px solid #2C5C7C`,
            whiteSpace: 'nowrap',
            background: stage.kind === 'wall' ? '#2C5C7C' : 'transparent',
            color: W.barInk,
            cursor: 'pointer',
            fontSize: 11,
            font: 'inherit',
          }}
        >
          大屏
        </button>

        <button
          type="button"
          onClick={() => onStage({ kind: 'governance' })}
          data-fact="governance"
          title="账号、审计与推送渠道"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 24,
            // 不给固定宽度：中文两字塞进 26px 圆里会竖排成两列
            padding: '0 9px',
            borderRadius: 12,
            border: `1px solid #2C5C7C`,
            whiteSpace: 'nowrap',
            background: stage.kind === 'governance' ? '#2C5C7C' : 'transparent',
            color: W.barInk,
            cursor: 'pointer',
            fontSize: 11,
            font: 'inherit',
          }}
        >
          治理
        </button>

        {/* 演示流程：「教我用」，不是业务动作，所以放最右跟业务入口分开。 */}
        <button
          type="button"
          onClick={startTour}
          data-tour-entry=""
          title="带人走一遍从下雨到归档的完整链路（← → 翻步，Esc 退出）"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            height: 24,
            padding: '0 8px',
            borderRadius: 12,
            border: `1px solid #2C5C7C`,
            background: 'transparent',
            color: W.barInk,
            cursor: 'pointer',
            fontSize: 11,
            font: 'inherit',
          }}
        >
          演示流程
        </button>

        {/* 身份与出口。删掉侧栏之后，这里是唯一的「我是谁 / 怎么走」。
            只读账号也要能看见自己是谁——否则点了按钮被 403 会一头雾水。 */}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            paddingLeft: 8,
            borderLeft: '1px solid #2C5C7C',
          }}
          title={`${session.user?.displayName ?? '未登录'} · ${session.user?.roleLabel ?? '—'}`}
        >
          <span
            style={{
              width: 20,
              height: 20,
              borderRadius: 10,
              background: '#2C5C7C',
              display: 'grid',
              placeItems: 'center',
              fontSize: 10,
              fontWeight: 700,
              color: W.barInk,
              flex: '0 0 auto',
            }}
          >
            {(session.user?.displayName ?? '?').slice(0, 1)}
          </span>
          <span style={{ fontSize: 11, maxWidth: 78, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {session.user?.displayName ?? '未登录'}
          </span>
          <span style={{ fontSize: 10, color: W.barInkDim }}>{session.user?.roleLabel ?? '—'}</span>
        </span>

        <button
          type="button"
          onClick={() => session.logout.mutate()}
          data-logout=""
          title="退出登录"
          style={{
            border: 0,
            background: 'none',
            color: W.barInkDim,
            cursor: 'pointer',
            fontSize: 11,
            font: 'inherit',
            padding: '0 2px',
          }}
        >
          退出
        </button>
      </div>
    </div>
  )
}

function Fact({
  label,
  value,
  unit,
  tone,
  mono = true,
  active,
  factKey,
  onClick,
  title,
}: {
  label: string
  value: string | number
  unit?: string
  tone?: string
  mono?: boolean
  active?: boolean
  /** 给测试脚本一个稳定的锚点。**不要用文本找按钮**——数值会变（「3 项」变「4 项」）。 */
  factKey?: string
  onClick?: () => void
  title?: string
}) {
  const inner = (
    <>
      <span style={{ fontSize: 10.5, color: W.barInkDim, marginRight: 2 }}>{label}</span>
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: tone ?? W.barInk,
          fontFamily: mono ? W.mono : W.sans,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
      {unit && <span style={{ fontSize: 10, color: W.barInkDim }}>{unit}</span>}
    </>
  )
  const style = {
    display: 'flex',
    alignItems: 'baseline',
    gap: 4,
    padding: '4px 9px',
    borderRadius: 6,
    border: `1px solid ${active ? '#2C5C7C' : 'transparent'}`,
    background: active ? '#1A3F5C' : 'transparent',
    marginRight: 4,
    whiteSpace: 'nowrap' as const,
  }
  if (!onClick) {
    return (
      <span style={style} title={title}>
        {inner}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      data-fact={factKey}
      title={title}
      style={{ ...style, color: W.barInk, cursor: 'pointer', font: 'inherit', transition: `background 160ms ${ease}` }}
    >
      {inner}
    </button>
  )
}
