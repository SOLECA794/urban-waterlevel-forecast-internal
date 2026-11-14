import { AnimatePresence, motion } from 'motion/react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { UiIconCmp } from './UiIcon'

/**
 * 轻提示（Toast）。
 *
 * 用它代替 `alert()` 和「改完数字不变」的静默操作：
 * 用户点了一下，屏幕上必须有东西变了——否则他不知道点没点上。
 *
 * 三类语义：
 * | kind | 用在哪 |
 * |---|---|
 * | ok | 操作完成（已确认、已复制、已切到该站） |
 * | err | 操作被后端拒绝（409 的原话要原样透出，不能吞） |
 * | info | 只是告知（地图已定位、筛选已应用） |
 *
 * 注意：**不用它报错到需要用户决策的程度**。那种情况是抽屉里的错误态，
 * 因为 toast 会飘走，用户没看清就没了。
 */

export type ToastKind = 'ok' | 'err' | 'info'

interface ToastItem {
  id: number
  kind: ToastKind
  text: string
  detail?: string
}

interface ToastApi {
  push: (kind: ToastKind, text: string, detail?: string) => void
  ok: (text: string, detail?: string) => void
  err: (text: string, detail?: string) => void
  info: (text: string, detail?: string) => void
}

const Ctx = createContext<ToastApi | null>(null)

const STYLE: Record<ToastKind, { bg: string; fg: string; bar: string }> = {
  ok: { bg: '#F0FAF4', fg: '#16653A', bar: '#15803D' },
  err: { bg: '#FDF2F2', fg: '#8F1D1D', bar: '#DC2626' },
  info: { bg: '#F1F7FD', fg: '#1B4A78', bar: '#0284C7' },
}

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)

  const push = useCallback((kind: ToastKind, text: string, detail?: string) => {
    seq.current += 1
    const id = seq.current
    setItems((prev) => [...prev.slice(-3), { id, kind, text, detail }])
    // err 留久一点：用户可能要读原话
    const ttl = kind === 'err' ? 5200 : 2600
    window.setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== id)), ttl)
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      push,
      ok: (text, detail) => push('ok', text, detail),
      err: (text, detail) => push('err', text, detail),
      info: (text, detail) => push('info', text, detail),
    }),
    [push],
  )

  return (
    <Ctx.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        style={{
          position: 'fixed',
          left: '50%',
          transform: 'translateX(-50%)',
          bottom: 26,
          zIndex: 9000,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          pointerEvents: 'none',
        }}
      >
        <AnimatePresence initial={false}>
          {items.map((it) => {
            const s = STYLE[it.kind]
            return (
              <motion.div
                key={it.id}
                initial={{ opacity: 0, y: 14, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.14 } }}
                transition={{ type: 'spring', stiffness: 520, damping: 34, mass: 0.6 }}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 9,
                  minWidth: 240,
                  maxWidth: 460,
                  padding: '9px 13px 9px 11px',
                  borderRadius: 9,
                  background: s.bg,
                  boxShadow: '0 6px 22px rgba(11,37,69,0.16)',
                  border: `1px solid ${s.bar}33`,
                  borderLeft: `3px solid ${s.bar}`,
                }}
              >
                {it.kind === 'ok' ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={s.fg} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ marginTop: 1, flexShrink: 0 }}>
                    <path d="m5 12.5 4.5 4.5L19 7" />
                  </svg>
                ) : (
                  <span style={{ color: s.fg, marginTop: 1, flexShrink: 0 }}>
                    <UiIconCmp name={it.kind === 'err' ? 'close' : 'pin'} size={15} />
                  </span>
                )}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: s.fg, lineHeight: 1.45 }}>{it.text}</div>
                  {it.detail ? (
                    <div style={{ fontSize: 11.5, color: s.fg, opacity: 0.78, marginTop: 2, lineHeight: 1.45 }}>{it.detail}</div>
                  ) : null}
                </div>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  )
}

export function useToast(): ToastApi {
  const v = useContext(Ctx)
  if (!v) {
    // 没挂 ToastHost 时降级成 no-op，避免整页崩掉（比如登录页没包）
    return { push: () => {}, ok: () => {}, err: () => {}, info: () => {} }
  }
  return v
}

/** 供页面设置 document.title 之外的可访问性提示用：把状态变化读给读屏软件。 */
export function useAnnounce(text: string | null) {
  useEffect(() => {
    if (!text) return
    const el = document.createElement('div')
    el.setAttribute('role', 'status')
    el.setAttribute('aria-live', 'polite')
    el.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)'
    el.textContent = text
    document.body.appendChild(el)
    const t = window.setTimeout(() => el.remove(), 1200)
    return () => {
      window.clearTimeout(t)
      el.remove()
    }
  }, [text])
}

