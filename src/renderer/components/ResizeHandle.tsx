import { useCallback, useRef } from 'react'

interface Props {
  orientation: 'vertical' | 'horizontal'
  /** Called with the pointer delta in pixels since the drag started. */
  onDelta: (delta: number) => void
  /** Double-clicking a divider is the conventional way to collapse it. */
  onDoubleClick?: () => void
  title?: string
}

/**
 * A draggable divider between panes.
 *
 * Uses pointer capture rather than window-level mouse listeners so a fast drag
 * that outruns the cursor still tracks, and so the drag ends cleanly even if
 * the pointer is released over the embedded browser view — which is a native
 * layer and would otherwise swallow the mouseup entirely.
 */
export function ResizeHandle({ orientation, onDelta, onDoubleClick, title }: Props): JSX.Element {
  const origin = useRef(0)
  const dragging = useRef(false)

  const start = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragging.current = true
      origin.current = orientation === 'vertical' ? e.clientX : e.clientY
      e.currentTarget.setPointerCapture(e.pointerId)
      // Stop the drag from selecting text across the whole app.
      document.body.style.userSelect = 'none'
      document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize'
    },
    [orientation]
  )

  const move = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return
      const point = orientation === 'vertical' ? e.clientX : e.clientY
      const delta = point - origin.current
      if (delta === 0) return
      origin.current = point
      onDelta(delta)
    },
    [orientation, onDelta]
  )

  const end = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }, [])

  return (
    <div
      className={`resize-handle resize-${orientation}`}
      title={title ?? 'Drag to resize · double-click to collapse'}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onDoubleClick}
    />
  )
}
