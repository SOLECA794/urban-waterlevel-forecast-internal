import { cloneElement, isValidElement, useRef, type CSSProperties, type ReactElement, type PointerEvent as RPointerEvent } from 'react'
import type { Rect, WidgetId } from './layout'
import { MIN_H, MIN_W, WIDGET_TITLE, clampRect } from './layout'
import { useSceneRuntime } from './scene'
import type { Palette } from './theme'

/**
 * 一个可拖拽、可缩放的桌面小组件外壳。
 *
 * 只在「布局模式」下接管鼠标：平时它是纯展示（大屏常年无人操作，
 * 一旦允许随手拖动，保洁员擦屏就会把版面拖乱）。
 *
 * 坐标换算：画布整体有 transform: scale()，指针位移是屏幕像素，
 * 必须除以 scale 才是画布像素，否则在非 1920×1080 的屏上会「拖得比鼠标慢」。
 *
 * 场景可见性：不在当前场景里的组件**不卸载，只淡出**。
 * 卸载会让 SVG 图表重算、地图重新取瓦片，切屏时出现一片空白；
 * 淡出则什么都不用重建。整层的「淡出→换版面→淡入」由 BoardPage 负责，
 * 这里只管自己这一块该不该露脸。
 */
export function Widget({
  id,
  rect,
  scale,
  editing,
  p,
  onChange,
  onCommit,
  children,
}: {
  id: WidgetId
  rect: Rect
  scale: number
  editing: boolean
  p: Palette
  onChange: (id: WidgetId, next: Rect) => void
  onCommit: () => void
  children: ReactElement<{ style?: CSSProperties }>
}) {
  const scene = useSceneRuntime()
  const visible = scene ? scene.visible.has(id) : true
  const drag = useRef<{ mode: 'move' | 'resize'; x: number; y: number; rect: Rect } | null>(null)

  const start = (mode: 'move' | 'resize') => (e: RPointerEvent<HTMLDivElement>) => {
    if (!editing) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
    drag.current = { mode, x: e.clientX, y: e.clientY, rect }
  }

  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.x) / scale
    const dy = (e.clientY - d.y) / scale
    const next =
      d.mode === 'move'
        ? clampRect({ ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy })
        : clampRect({ ...d.rect, w: d.rect.w + dx, h: d.rect.h + dy })
    onChange(id, next)
  }

  const end = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    ;(e.currentTarget as HTMLDivElement).releasePointerCapture?.(e.pointerId)
    onCommit()
  }

  const inner = isValidElement(children)
    ? cloneElement(children, {
        style: { ...(children.props.style ?? {}), height: '100%', width: '100%' },
      })
    : children

  return (
    <div
      aria-hidden={visible ? undefined : true}
      style={{
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        zIndex: editing ? 20 : visible ? 4 : 3,
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        // 淡出用 260ms：比整层的叠化略短，组件在层还没完全暗下来时就已经退场，
        // 观感上是「内容先走、幕布再落」，而不是两层同时变灰。
        transition: editing ? undefined : 'opacity 260ms ease',
        outline: editing ? `1.5px dashed ${p.accent}99` : undefined,
        outlineOffset: 2,
        borderRadius: 16,
      }}
    >
      {inner}

      {editing && (
        <>
          {/* 拖拽条压在面板标题栏上：比「标题也能拖」更明确，也不会和卡内的选择操作打架 */}
          <div
            onPointerDown={start('move')}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              height: 20,
              cursor: 'grab',
              background: 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              paddingRight: 10,
              gap: 5,
              fontSize: 9.5,
              letterSpacing: 0.5,
              color: `${p.accent}CC`,
              userSelect: 'none',
            }}
            title="按住拖动这个组件"
          >
            <span style={{ letterSpacing: 2 }}>⠿</span>
            {WIDGET_TITLE[id]}
          </div>

          <div
            onPointerDown={start('resize')}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            style={{
              position: 'absolute',
              right: 0,
              bottom: 0,
              width: 18,
              height: 18,
              cursor: 'nwse-resize',
              background: `linear-gradient(135deg, transparent 45%, ${p.accent} 46%, ${p.accent} 58%, transparent 59%)`,
              borderBottomRightRadius: 14,
            }}
          />

          {(rect.w <= MIN_W + 1 || rect.h <= MIN_H + 1) && (
            <div
              style={{
                position: 'absolute',
                left: 8,
                bottom: 6,
                fontSize: 9.5,
                color: p.level.red,
                background: '#fff',
                padding: '1px 5px',
                borderRadius: 4,
              }}
            >
              已到最小尺寸
            </div>
          )}
        </>
      )}
    </div>
  )
}
