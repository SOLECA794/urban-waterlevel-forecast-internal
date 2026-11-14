import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { T } from '../../utils/tokens'
import { UiIconCmp } from './UiIcon'

/**
 * 右侧抽屉：地图/列表旁边的详情容器。
 *
 * ## 为什么是抽屉，不是弹窗
 *
 * 弹窗会盖住地图，用户就看不见「这个点在哪、周围还有谁」。
 * 抽屉从右边滑出，地图仍然占着主视野，而且能继续拖、继续点别的点——
 * 这才是地图类应用的正常用法（高德、Windy、Grafana 都是这样）。
 *
 * ## 交互契约
 *
 * | 行为 | 结果 |
 * |---|---|
 * | 点地图标记 | 抽屉滑入，内容切到该站 |
 * | 点另一处标记 | 抽屉**不关闭**，内容原地切换（避免闪一下） |
 * | Esc | 关闭，焦点还给触发它的元素 |
 * | 点抽屉外（地图上） | 不关闭——地图点击本身就是「换一站」，关了再开是多余动效 |
 * | 拖左边缘 | 宽度 380~760 可调，双击复位；宽度记进 localStorage |
 *
 * 宽度是本地偏好，不是业务状态，所以放 localStorage 而不是 URL——
 * 分享链接时不该把「我习惯多宽」也分享出去。
 *
 * 焦点管理：打开时焦点进抽屉，关闭时还回触发元素。
 * 不做焦点陷阱是因为**地图本身也要能继续用**——键盘用户按 Tab 应该能走到地图控件。
 */
const WIDTH_KEY = 'wl-drawer-w'
const W_MIN = 380
const W_MAX = 760

function readStoredWidth(fallback: number): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY)
    if (raw === null) return fallback
    const n = Number(raw)
    return Number.isFinite(n) ? Math.min(W_MAX, Math.max(W_MIN, n)) : fallback
  } catch {
    return fallback
  }
}

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  aside,
  children,
  width = 460,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  /** 标题右侧的操作区（按钮、标签） */
  aside?: ReactNode
  children: ReactNode
  width?: number
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const returnRef = useRef<Element | null>(null)

  // 宽度可拖。为什么值得做：曲线在 470px 里只能看个大概，
  // 宽屏用户想同时看「曲线 + 四个预见期的表」，就得能拉到 700+。
  const [w, setW] = useState(() => readStoredWidth(width))
  const [grip, setGrip] = useState(false)
  useEffect(() => {
    setW(readStoredWidth(width))
  }, [width])

  const onGripDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const startW = w
      let latest = startW
      setGrip(true)
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'

      const move = (ev: PointerEvent) => {
        // 往左拖是变宽，所以要取反
        latest = Math.min(W_MAX, Math.max(W_MIN, startW + (startX - ev.clientX)))
        setW(latest)
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
        setGrip(false)
        try {
          window.localStorage.setItem(WIDTH_KEY, String(Math.round(latest)))
        } catch {
          /* 隐私模式下写不了，不影响使用 */
        }
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [w],
  )

  const resetWidth = useCallback(() => {
    setW(W_MIN + 90)
    try {
      window.localStorage.setItem(WIDTH_KEY, String(W_MIN + 90))
    } catch {
      /* 同上 */
    }
  }, [])

  // 记录打开前的焦点，关闭时还回去——否则键盘用户会掉到文档开头
  useEffect(() => {
    if (open) {
      returnRef.current = document.activeElement
      const t = window.setTimeout(() => panelRef.current?.focus(), 60)
      return () => window.clearTimeout(t)
    }
    const el = returnRef.current
    if (el instanceof HTMLElement) el.focus({ preventScroll: true })
    return undefined
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // 用 createPortal 挂到 body。
  //
  // 不是为了好看，是因为**任何一个祖先有 transform 都会让 position:fixed 失效**：
  // CSS 规定 transform/filter/perspective 会替后代建立新的包含块，
  // 于是 fixed 变成「相对那个祖先」，不再是「相对视口」。
  // 这里踩到的是 `Layout.tsx` 的 `.page-enter` —— 它跑的是 `animation: pageIn`，
  // 计算值停在 `matrix(1,0,0,1,0,0)`（恒等矩阵，但不是 `none`）。
  // `/model` 的决策日志在首屏之下，滚到那里再开抽屉，抽屉就整块跟着文档走：
  // 实测 top=-1190、高 2180，把手在视口外，**拖都拖不到**。
  // 而前三个页面没暴露这个问题，只是因为它们的内容刚好短。
  const panel = (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.aside
          key="drawer"
          ref={panelRef}
          tabIndex={-1}
          data-drawer="site"
          data-tour="site-drawer"
          aria-label="站点详情面板"
          initial={{ x: w, opacity: 0.4 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: w, opacity: 0.2 }}
          transition={{ type: 'spring', stiffness: 420, damping: 38, mass: 0.7 }}
          style={{
            // 用 fixed 不用 absolute：`/model` 的页面根容器高 2180px，
            // absolute 会让抽屉跟着**整篇文档**撑到同样高，滚到页面中部打开时
            // 抽屉的顶边在 -1190 处——把手压根不在视口里，拖都拖不到。
            // 详情面板本来就该钉在视口右侧，不跟着内容走。
            position: 'fixed',
            top: 0,
            right: 0,
            bottom: 0,
            width: w,
            display: 'flex',
            flexDirection: 'column',
            background: T.surface,
            borderLeft: `1px solid ${T.border1}`,
            boxShadow: '-12px 0 32px rgba(11,37,69,0.10)',
            outline: 'none',
            zIndex: 30,
          }}
        >
          {/* 左边缘拖拽把手。故意做得窄而低调：它是「知道才用」的能力，
              不该在每次打开抽屉时跟内容抢注意力。悬停/拖动时才显形。 */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整详情宽度"
            title="拖动调整宽度（双击复位）"
            onPointerDown={onGripDown}
            onDoubleClick={resetWidth}
            onMouseEnter={() => setGrip(true)}
            onMouseLeave={() => setGrip(false)}
            style={{
              position: 'absolute',
              left: -3,
              top: 0,
              bottom: 0,
              width: 8,
              cursor: 'col-resize',
              zIndex: 2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span
              style={{
                width: 3,
                height: grip ? 52 : 34,
                borderRadius: 2,
                background: grip ? T.primary : T.borderStrong,
                transition: 'height 140ms ease, background 140ms ease',
              }}
            />
          </div>

          <header
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: '14px 16px 12px',
              borderBottom: `1px solid ${T.border2}`,
              flexShrink: 0,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: T.text1, lineHeight: 1.35 }}>{title}</div>
              {subtitle ? (
                <div style={{ fontSize: 12, color: T.text2, marginTop: 3, lineHeight: 1.5 }}>{subtitle}</div>
              ) : null}
            </div>
            {aside ? <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>{aside}</div> : null}
            <button
              type="button"
              aria-label="关闭详情"
              onClick={onClose}
              style={{
                width: 28,
                height: 28,
                display: 'grid',
                placeItems: 'center',
                border: `1px solid ${T.border1}`,
                borderRadius: 7,
                background: T.surface,
                color: T.text2,
                cursor: 'pointer',
                flexShrink: 0,
                transition: 'background 120ms ease, color 120ms ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#F1F6FB'
                e.currentTarget.style.color = T.text1
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = T.surface
                e.currentTarget.style.color = T.text2
              }}
            >
              <UiIconCmp name="close" size={13} />
            </button>
          </header>

          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>{children}</div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  )

  return typeof document === 'undefined' ? panel : createPortal(panel, document.body)
}

/**
 * 区块标题：抽屉内部的分节。
 *
 * 大屏靠「一块块卡片」分节，应用里卡片套卡片会很脏，
 * 所以抽屉内部用小标题 + 细线分节，视觉噪声低一档。
 */
export function DrawerSection({
  title,
  aside,
  children,
  pad = true,
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
  pad?: boolean
}) {
  return (
    <section data-sec={title} style={{ borderBottom: `1px solid ${T.border2}` }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: pad ? '12px 16px 6px' : '12px 16px 6px',
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: T.text3 }}>{title}</span>
        <div style={{ flex: 1, height: 1, background: T.border2 }} />
        {aside}
      </div>
      <div style={{ padding: pad ? '0 16px 14px' : 0 }}>{children}</div>
    </section>
  )
}
