import { useEffect } from 'react'
import { useWorkbench } from './useWorkbench'
import { FactBar } from './FactBar'
import { Rail } from './Rail'
import { Drill } from './Drill'
import { STAGE_TITLE, type Stage } from './model'
import type { StageCtx } from './ctx'
import { SituationStage } from './stages/Situation'
import { SiteStage } from './stages/Site'
import { EventStage } from './stages/Event'
import { HandoffStage } from './stages/Handoff'
import { TrustStage } from './stages/Trust'
import { RulesStage } from './stages/Rules'
import { PlumbingStage } from './stages/Plumbing'
import { GovernanceStage } from './stages/Governance'
import { WallStage } from './stages/Wall'
import { W, BAR_H, RAIL_W, ease } from './visual'

/**
 * **这一屏就是整个系统。**
 *
 * 十个页面曾经是「同一批数据换了十个筛选条件」；现在它们变成了
 * 顶栏的四个事实入口 + 左栏的对象列表 + 中舞台随选中展开的一片内容
 * + 右栏那条能回去的路。没有任何一次点击会换页，也没有任何一次点击
 * 会把用户刚才看的排序、筛选、滚动位置清掉。
 *
 * 这个文件只做接线与键盘，**不放任何业务判断**：
 * 舞台各自回答自己的问题，左栏只管有哪些对象，右栏只管从哪来。
 *
 * 三层纵向分区是固定的（顶栏 54 / 下面三栏 236 + 自适应 + 452），
 * 中舞台无论换到哪一块都不改变其他两块的位置——用户因此能形成肌肉记忆：
 * 「左栏永远是我可以选的对象，右栏永远是我看过的东西」。
 */
export function WorkbenchPage() {
  const { state, ctx, setQuery, setAlarmsOnly, flash, clearFlash } = useWorkbench()

  // 键盘：Esc 是「退一步」。栈里有东西就收一层，没有就回全域态势。
  // 刻意不做「再按一次回首页」那种两段式——值班时没人记得住第二段的触发条件。
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // 在输入框里按 Esc 是「撤销输入」，不该顺手把整个画面退掉。
        const t = e.target as HTMLElement | null
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
        if (ctx.state.trail.length > 0) ctx.pop()
        else ctx.home()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ctx])

  // 提示自动消失。错误给 5.2 秒——用户要读完后端那句 409 的原话。
  useEffect(() => {
    if (!flash) return
    const ms = flash.k === 'err' ? 5200 : 2600
    const id = window.setTimeout(clearFlash, ms)
    return () => window.clearTimeout(id)
  }, [flash, clearFlash])

  const stage = state.stage

  return (
    <div
      data-workbench=""
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: W.shell,
        fontFamily: W.sans,
        color: W.ink,
        overflow: 'hidden',
      }}
    >
      <FactBar stage={stage} onStage={ctx.goStage} />

      <div style={{ flex: '1 1 0', minHeight: 0, display: 'flex', alignItems: 'stretch' }}>
        <Rail
          stage={stage}
          sort={state.sort}
          query={state.query}
          alarmsOnly={state.alarmsOnly}
          onSort={ctx.setSort}
          onQuery={setQuery}
          onAlarmsOnly={setAlarmsOnly}
          onPickSite={(siteId) => {
            // 点列表 = 两件事同时发生：中舞台换成这个站，右栏记下这一步。
            // 必须用 `pick` 一次做完：拆成 goStage + openSite 两步时，
            // goStage 的「换舞台清空栈」会先执行，横向换站就永远只剩一层。
            ctx.pick({ kind: 'site', siteId }, { kind: 'site', siteId, name: siteId })
          }}
          onPickEvent={(eventId, _siteId, level) => {
            ctx.pick(
              { kind: 'event', eventId },
              { kind: 'event', eventId, name: `预警 #${eventId}`, level: level as never },
            )
          }}
        />

        <main
          style={{
            flex: '1 1 0',
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            background: W.stage,
          }}
        >
          <StageHead stage={stage} ctx={ctx} />
          <div
            data-stage-body={stage.kind}
            data-tour="wb-stage"
            style={{ flex: '1 1 0', minHeight: 0, display: 'flex', padding: 12 }}
          >
            <StageBody ctx={ctx} />
          </div>
        </main>

        <Drill ctx={ctx} />
      </div>

      {flash && (
        <div
          data-flash={flash.k}
          style={{
            position: 'fixed',
            left: '50%',
            bottom: 22,
            transform: 'translateX(-50%)',
            maxWidth: 620,
            padding: '9px 14px',
            borderRadius: 8,
            fontSize: 12.5,
            lineHeight: 1.6,
            // 错误必须能被读完整：后端那句 409 的原话是有业务价值的
            // （「不能从「已处置」直接改为「误报归档」」），不许被改写或截断。
            color: flash.k === 'err' ? '#fff' : W.ink,
            background: flash.k === 'err' ? W.bad : W.stage,
            border: `1px solid ${flash.k === 'err' ? W.bad : W.line}`,
            boxShadow: '0 8px 26px rgba(13,31,51,0.18)',
            zIndex: 60,
            transition: `opacity 200ms ${ease}`,
          }}
        >
          {flash.msg}
        </div>
      )}
    </div>
  )
}

/** 中舞台的标题条。它回答「我现在在看什么」，顺便给一个回全域态势的出口。 */
function StageHead({ stage, ctx }: { stage: Stage; ctx: StageCtx }) {
  const isHome = stage.kind === 'situation'
  return (
    <header
      data-stage-head={stage.kind}
      style={{
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '0 12px',
        height: BAR_H - 14,
        borderBottom: `1px solid ${W.line}`,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: W.ink }}>
        {STAGE_TITLE[stage.kind]}
      </h3>
      <span style={{ fontSize: 11, color: W.ink4 }}>
        {isHome
          ? '没有人选中对象时看到的就是这一屏'
          : '左边换对象、右边看路径，这一块永远跟着你的选择走'}
      </span>
      {!isHome && (
        <button
          type="button"
          onClick={ctx.home}
          style={{
            marginLeft: 'auto',
            border: `1px solid ${W.line}`,
            background: W.stage,
            borderRadius: 6,
            padding: '4px 9px',
            fontSize: 11,
            color: W.ink2,
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          回到全域态势
        </button>
      )}
    </header>
  )
}

/**
 * 舞台分发。
 *
 * 用 `switch` 而不是查表：查表（`Record<Stage['kind'], Component>`）看着更短，
 * 但会让每个舞台的类型参数变成 `any`，而这里恰恰每个舞台的入参都不同
 * （site 要 siteId、event 要 eventId、其余只要 ctx）。类型检查在这一层丢掉，
 * 到运行时就是白屏。
 */
function StageBody({ ctx }: { ctx: StageCtx }) {
  const s = ctx.state.stage
  switch (s.kind) {
    case 'situation':
      return <SituationStage ctx={ctx} />
    case 'site':
      return <SiteStage ctx={ctx} siteId={s.siteId} />
    case 'event':
      return <EventStage ctx={ctx} eventId={s.eventId} />
    case 'handoff':
      return <HandoffStage ctx={ctx} />
    case 'trust':
      return <TrustStage ctx={ctx} />
    case 'rules':
      return <RulesStage ctx={ctx} />
    case 'plumbing':
      return <PlumbingStage ctx={ctx} />
    case 'governance':
      return <GovernanceStage ctx={ctx} />
    case 'wall':
      return <WallStage ctx={ctx} />
  }
}

export { RAIL_W }
