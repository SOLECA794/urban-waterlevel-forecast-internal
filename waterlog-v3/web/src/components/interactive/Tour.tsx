import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Emph } from '../primitives/Rich'
import { T } from '../../utils/tokens'
import { UiIconCmp } from './UiIcon'

/**
 * 演示流程（Guided tour）：带人走一遍系统该怎么用。
 *
 * ## 为什么交付级系统需要这个
 *
 * 系统有九个页面，每页十几处可点。第一次来的人不会知道「先看哪、再看哪」——
 * 他会在站点列表里点开三个抽屉，然后以为自己已经看懂了。
 * 而评审、交接、验收这三种场合，恰恰**不允许**对方自己摸索：要在十分钟内
 * 让他看见「从下雨到报警到派人到归档」这条链是通的。
 *
 * 所以流程不是教程，是**一条被写下来的读法**：每一步只讲一件事，
 * 且这一步要落在屏幕上的某个真实控件上——指着说，比让人找强得多。
 *
 * ## 契约
 *
 * | 行为 | 结果 |
 * |---|---|
 * | 目标元素在 `data-tour` 上 | 光斑框住它，卡片贴着它放（自动避开视口边界） |
 * | 目标不在 DOM 里 | 卡片居中、不画光斑，**流程不中断**（页面可能在加载） |
 * | ← / → | 上一步 / 下一步 |
 * | Esc | 退出，不记「已看过」（下次还能重放） |
 * | 目标在视口外 | 先 `scrollIntoView` 再定位 |
 * | `prefers-reduced-motion` | 去掉位移与淡入，只留光斑 |
 *
 * ## 为什么用 `data-tour` 而不是 CSS 选择器
 *
 * 同一个教训在这个项目里已经踩过三次了：按「第几个 / 什么形状」找元素，
 * 一定会在某个页面找到别的东西。名字是唯一的稳定契约，
 * 而且它不绑定样式——改版不会让流程失效。
 */

export interface TourStep {
  /** 路由。与上一步不同时会先跳转。 */
  route?: string
  /** 锚点：元素上的 `data-tour="xxx"`。省略则卡片居中。 */
  anchor?: string
  title: string
  body: string
  /** 进入这一步时替用户做的一次点击（选择器，同样优先用 data-* 名字） */
  click?: string
  /** 卡片优先放哪一侧。空间不够会自动换边。 */
  side?: 'top' | 'bottom' | 'left' | 'right'
}

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

const PAD = 6
const CARD_W = 344
const GAP = 14
const MARGIN = 12

function measure(el: Element | null): Rect | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) return null
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

/** 把卡片放到目标旁边，必要时翻边、必要时贴边夹住。 */
function placeCard(target: Rect | null, side: TourStep['side'], vw: number, vh: number) {
  if (!target) {
    return { top: Math.max(MARGIN, vh / 2 - 130), left: Math.max(MARGIN, vw / 2 - CARD_W / 2) }
  }
  const prefer = side ?? 'bottom'
  const roomBelow = vh - (target.top + target.height) - MARGIN
  const roomAbove = target.top - MARGIN
  const roomRight = vw - (target.left + target.width) - MARGIN
  const roomLeft = target.left - MARGIN

  // 需求侧放不下就翻边。宁可换位置，也不要把卡片顶出屏幕。
  let use = prefer
  if (prefer === 'bottom' && roomBelow < 170 && roomAbove > roomBelow) use = 'top'
  else if (prefer === 'top' && roomAbove < 170 && roomBelow > roomAbove) use = 'bottom'
  else if (prefer === 'right' && roomRight < CARD_W && roomLeft > roomRight) use = 'left'
  else if (prefer === 'left' && roomLeft < CARD_W && roomRight > roomLeft) use = 'right'

  let top = 0
  let left = 0
  if (use === 'bottom') {
    top = target.top + target.height + GAP
    left = target.left + target.width / 2 - CARD_W / 2
  } else if (use === 'top') {
    top = target.top - GAP - 150
    left = target.left + target.width / 2 - CARD_W / 2
  } else if (use === 'right') {
    top = target.top + target.height / 2 - 70
    left = target.left + target.width + GAP
  } else {
    top = target.top + target.height / 2 - 70
    left = target.left - GAP - CARD_W
  }
  // 夹进视口。这条不能省：宽屏截图没问题，1280 笔记本上卡片会半边在屏幕外。
  left = Math.min(vw - CARD_W - MARGIN, Math.max(MARGIN, left))
  top = Math.min(vh - 150 - MARGIN, Math.max(MARGIN, top))
  return { top, left }
}

export function Tour({
  steps,
  index,
  onIndex,
  onExit,
  onGo,
}: {
  steps: readonly TourStep[]
  index: number
  onIndex: (i: number) => void
  onExit: () => void
  /** 需要跳页时由外部接管（那里才有 router） */
  onGo: (route: string) => void
}) {
  const step = steps[index]
  const [rect, setRect] = useState<Rect | null>(null)
  const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth))
  const [vh, setVh] = useState(() => (typeof window === 'undefined' ? 900 : window.innerHeight))
  const [missing, setMissing] = useState(false)
  const reduced = useRef(false)
  const clickDone = useRef<string>('')

  useEffect(() => {
    reduced.current =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }, [])

  // 跳页只在路由真的不同时才做。已在目标页还 nav 一次会把页面重挂载、丢掉刚打开的东西。
  useEffect(() => {
    if (step?.route && !locationMatches(step.route)) onGo(step.route)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])

  // 定位：元素可能要等接口回来才出现，所以轮询一小段时间而不是只量一次。
  useLayoutEffect(() => {
    let alive = true
    let tries = 0
    setRect(null)
    setMissing(false)

    const tick = () => {
      if (!alive) return
      setVw(window.innerWidth)
      setVh(window.innerHeight)
      const el = step?.anchor
        ? document.querySelector(`[data-tour="${step.anchor}"]`)
        : null
      if (el) {
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduced.current ? 'auto' : 'smooth' })
        // 等滚动落定再量，否则量到的是滚动前的位置
        window.setTimeout(() => {
          if (!alive) return
          setRect(measure(el))
        }, reduced.current ? 0 : 320)
        return
      }
      if (step?.anchor && tries++ < 20) {
        window.setTimeout(tick, 150)
      } else if (alive) {
        setMissing(!!step?.anchor)
      }
    }
    tick()
    return () => {
      alive = false
    }
  }, [index, step?.anchor])

  // 需要「顺手替用户点一下」的步骤。同一个锚点只点一次，避免来回翻页时反复触发。
  useEffect(() => {
    const sel = step?.click
    if (!sel) return
    const key = `${index}:${sel}`
    if (clickDone.current === key) return
    let alive = true
    let tries = 0
    const fire = () => {
      if (!alive) return
      const el = document.querySelector(sel) as HTMLElement | null
      if (el) {
        clickDone.current = key
        el.click()
        return
      }
      if (tries++ < 16) window.setTimeout(fire, 200)
    }
    fire()
    return () => {
      alive = false
    }
  }, [index, step?.click])

  const goto = useCallback(
    (i: number) => {
      if (i < 0) return
      if (i >= steps.length) onExit()
      else onIndex(i)
    },
    [steps.length, onIndex, onExit],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onExit()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goto(index + 1)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goto(index - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goto, index, onExit])

  if (!step) return null

  const card = placeCard(rect, step.side, vw, vh)
  const last = index === steps.length - 1
  const body = (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 90 }}
      role="dialog"
      aria-modal="false"
      aria-label="演示流程"
      data-tour-root=""
    >
      {/* 遮罩 + 光斑：一个元素搞定。四块拼边会在缩放时露出缝。 */}
      {rect ? (
        <div
          onClick={onExit}
          style={{
            position: 'fixed',
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            borderRadius: 10,
            boxShadow: '0 0 0 9999px rgba(11,37,69,0.52), 0 0 0 2px rgba(255,255,255,0.92) inset',
            transition: reduced.current ? 'none' : 'all 260ms cubic-bezier(.22,.61,.36,1)',
            pointerEvents: 'none',
          }}
        />
      ) : (
        <div
          onClick={onExit}
          style={{ position: 'fixed', inset: 0, background: 'rgba(11,37,69,0.52)' }}
        />
      )}

      <div
        role="document"
        style={{
          position: 'fixed',
          top: card.top,
          left: card.left,
          width: CARD_W,
          background: T.surface,
          border: `1px solid ${T.border1}`,
          borderRadius: 12,
          boxShadow: '0 18px 48px rgba(11,37,69,0.28)',
          padding: '14px 15px 12px',
          animation: reduced.current ? undefined : 'fadeUp 220ms cubic-bezier(.22,.61,.36,1) both',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span
            className="num"
            style={{
              fontSize: 10.5,
              letterSpacing: '0.08em',
              color: T.primary,
              background: 'rgba(14,116,144,0.10)',
              borderRadius: 4,
              padding: '1px 6px',
            }}
          >
            第 {index + 1} / {steps.length} 步
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onExit}
            title="退出演示（Esc）"
            aria-label="退出演示"
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: T.text3,
              display: 'grid',
              placeItems: 'center',
              padding: 2,
            }}
          >
            <UiIconCmp name="close" size={14} />
          </button>
        </div>

        <div style={{ fontSize: 14, fontWeight: 600, color: T.text1, marginBottom: 5 }}>
          {step.title}
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.68, color: T.text2 }}>
          <Emph text={step.body} strong={{ color: T.text1 }} />
        </div>

        {missing && (
          <div style={{ marginTop: 8, fontSize: 11, color: T.text3 }}>
            这一步的目标控件还没出现（页面可能正在加载），可以继续往下走。
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12 }}>
          {/* 进度点：让人知道还剩几步，比「3/9」更直观 */}
          <div style={{ display: 'flex', gap: 4, flex: 1 }}>
            {steps.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => goto(i)}
                aria-label={`跳到第 ${i + 1} 步`}
                style={{
                  width: i === index ? 16 : 6,
                  height: 6,
                  borderRadius: 3,
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  background: i === index ? T.primary : T.borderStrong,
                  transition: reduced.current ? 'none' : 'width 200ms ease, background 200ms ease',
                }}
              />
            ))}
          </div>
          <button type="button" className="btn" onClick={() => goto(index - 1)} disabled={index === 0}>
            上一步
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => goto(index + 1)}
            autoFocus
          >
            {last ? '完成' : '下一步'}
          </button>
        </div>
      </div>
    </div>
  )

  return typeof document === 'undefined' ? body : createPortal(body, document.body)
}

function locationMatches(route: string) {
  if (typeof window === 'undefined') return false
  const p = window.location.pathname
  if (route === '/') return p === '/'
  return p === route || p.startsWith(route + '/')
}
