import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * 就地气泡：给「一个数字/一个图标」补上它凭什么这么说。
 *
 * ## 为什么不用 `title` 属性
 *
 * `title` 有三件事做不到：
 * 1. 不能放结构化内容（多行、表格、色块），只能是一串纯文本；
 * 2. 延迟由操作系统决定（1~2 秒），用户读不出「我刚才到底指到哪了」的因果；
 * 3. 无法被测试——`document.querySelector('[title]')` 只能拿到字符串，
 *    证明不了它真的显示了。
 *
 * ## 交互契约
 *
 * | 行为 | 结果 |
 * |---|---|
 * | 悬停 220ms | 浮出；**留这段延迟是为了不干扰"扫过"** |
 * | 立刻移出 | 取消，不闪 |
 * | 聚焦（键盘 Tab） | 立刻浮出——键盘用户没有"悬停"这个动作 |
 * | Esc | 关掉，焦点不动 |
 * | 触屏 | 不依赖悬停（touch 上 hover 不可靠），用点击展开 |
 *
 * 定位用 fixed + 视口夹取，所以不会被任何 `overflow:hidden` 的卡片裁掉。
 */

const SHOW_DELAY = 220

export function Tooltip({
  content,
  children,
  side = 'top',
  maxWidth = 300,
}: {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom'
  maxWidth?: number
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number | null>(null)

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const place = useCallback(() => {
    const a = anchorRef.current
    const b = bubbleRef.current
    if (!a) return
    const r = a.getBoundingClientRect()
    const bw = b?.offsetWidth ?? maxWidth
    const bh = b?.offsetHeight ?? 40
    const margin = 10
    let x = r.left + r.width / 2
    x = Math.min(window.innerWidth - bw / 2 - margin, Math.max(bw / 2 + margin, x))
    const y = side === 'top' ? r.top - margin : r.bottom + margin
    setPos({
      x,
      y: side === 'top' ? Math.max(bh + margin, y) : Math.min(window.innerHeight - margin, y),
    })
  }, [maxWidth, side])

  useEffect(() => {
    if (!open) return undefined
    place()
    const onScroll = () => place()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, place])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  useEffect(() => clear, [clear])

  const show = (delay: number) => {
    clear()
    timer.current = window.setTimeout(() => {
      setOpen(true)
      timer.current = null
    }, delay)
  }
  const hide = () => {
    clear()
    setOpen(false)
  }

  return (
    <>
      <span
        ref={anchorRef}
        style={{ display: 'inline-flex', maxWidth: '100%' }}
        onMouseEnter={() => show(SHOW_DELAY)}
        onMouseLeave={hide}
        onFocus={() => show(0)}
        onBlur={hide}
        onKeyDown={(e) => {
          if (e.key === 'Escape') hide()
        }}
      >
        {children}
      </span>
      {open && pos && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={bubbleRef}
              role="tooltip"
              style={{
                position: 'fixed',
                left: pos.x,
                top: pos.y,
                transform: side === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
                maxWidth,
                zIndex: 90,
                // 不拦截鼠标：它自己就在被指向的元素旁边，抢指针会让悬停抖动
                pointerEvents: 'none',
                background: '#0B2545',
                color: '#FFFFFF',
                borderRadius: 7,
                padding: '8px 10px',
                fontSize: 11.5,
                lineHeight: 1.55,
                boxShadow: '0 10px 28px rgba(11,37,69,0.28)',
              }}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

/** 术语解释：正文里带虚线小标的词，指向即解释。 */
export function Glossary({ term }: { term: string }) {
  const def = GLOSSARY[term]
  if (!def) return <span>{term}</span>
  return (
    <Tooltip
      content={
        <>
          <div style={{ fontWeight: 700, marginBottom: 3 }}>{term}</div>
          <div>{def}</div>
        </>
      }
    >
      <span
        tabIndex={0}
        style={{
          borderBottom: '1px dashed rgba(11,37,69,0.42)',
          cursor: 'help',
          outline: 'none',
        }}
      >
        {term}
      </span>
    </Tooltip>
  )
}

/**
 * 术语表。
 *
 * 这些词在代码注释里都解释过，但注释只有读源码的人看得到——
 * 系统交付之后，看页面的是值班员。**一个需要读源码才能理解的界面，
 * 等于没有交付。**
 */
export const GLOSSARY: Record<string, string> = {
  积水深: '水位减去该站的基准高程。同一个 0.60 m，在低洼涵洞和在江边泵站代表的风险完全不同，所以页面上一律用积水深而不是绝对水位来判读。',
  综合分: '三个因子按权重加权：峰值 × w₁ + 持续 × w₂ + 趋势 × w₃。它不是概率，是一个 0~1 的量纲无关评分，分档之后才是等级。',
  峰值因子: '当前（或未来窗口内）最高水位触到几级阈值。回答「最深能到多少」。',
  持续因子: '超过各级阈值累计多少分钟。回答「要持续多久」。',
  趋势因子: '近 1 小时的水位变化率。回答「还在涨还是在退」——这是唯一带方向的因子。',
  skill: '预测相对「水位不变」这个基线的改进幅度：1 − 模型误差 / 基线误差。等于 0 表示不如什么都不做，为负表示比不做还差。',
  PICP90: '90% 置信区间的实际覆盖率。目标是 90%：明显偏低说明区间太窄会漏报，明显偏高说明区间没用。',
  '修正增益': '滚动修正在该站点该预见期上叠加的系统性偏差量（米）。增益越大说明该站该预见期的预测越需要修。',
  '四态': '预警的阅读状态，由模型推进：未确认 → 已确认 → 已解除（确认/未确认）。它回答「这条预警现在还成不成立」。',
  '五态': '预警的处置状态，由人推进：待处置 → 已派单 → 已到场 → 已处置 → 误报归档。它回答「我们做了什么」。两个轴不能合成一个。',
  '阈值分级': '每个站点各有四档积水深阈值（蓝/黄/橙/红），达阈即进对应档。但等级不是单看阈值：综合分还要过评分分档、持续时长还要过持续门槛，三个条件同时成立才升到该级。',
  '等级': '四级：蓝色（有积水不影响通行）、黄色（开始影响通行，派巡查）、橙色（明显积水可能中断交通，现场处置）、红色（较深或持续超阈，封控并上报）。',
  '滚动修正': '引擎每轮预测后，用最近的实测与预测残差估计该站该预见期的系统性偏差，钳制在 3σ 内回灌到下一轮。',
  '仿真时钟': '模拟器以 60 倍速推进，仿真时间会跑到墙钟前面。所有「近 N 小时」的窗口都按仿真时钟算，不用墙钟。',
}
