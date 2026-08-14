import { useEffect, useLayoutEffect, useRef } from 'react'
import type { TabInfo } from '../../main/browser/BrowserPane'

interface Props {
  tabs: TabInfo[]
  height: number
  onClose: () => void
}

/**
 * Hosts the embedded web view.
 *
 * The actual page is a native view painted over this window by the main
 * process, not a DOM element — so this component's only job is to reserve the
 * right rectangle and keep reporting it as the layout changes.
 */
export function BrowserPanel({ tabs, height, onClose }: Props): JSX.Element {
  const slotRef = useRef<HTMLDivElement>(null)
  const active = tabs.find((t) => t.active) ?? null

  // Keep the native view pinned to this element through every resize, scroll
  // and re-render. A missed update leaves the page floating over the wrong part
  // of the window, which looks like a rendering bug rather than a layout one.
  useLayoutEffect(() => {
    const el = slotRef.current
    if (!el) return

    const report = (): void => {
      const r = el.getBoundingClientRect()
      void window.backfile.browserSetBounds({
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      })
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  })

  /*
   * Collapse the reserved rectangle when this panel goes away.
   *
   * The page is a native view painted over the window, so unmounting this
   * component does not hide it — without this, "Hide" left the web page
   * stubbornly covering the source table. Kept in its own mount-scoped effect
   * so it fires on unmount only, not on every re-render of the effect above.
   */
  useEffect(() => {
    return () => {
      void window.backfile.browserSetBounds({ x: 0, y: 0, width: 0, height: 0 })
    }
  }, [])

  return (
    <section className="browser-panel" style={{ height }}>
      <div className="tabstrip">
        <div className="tabstrip-tabs">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`browser-tab${tab.active ? ' is-active' : ''}${
                tab.brokenOut ? ' is-broken-out' : ''
              }`}
              onClick={() => window.backfile.browserActivate(tab.id)}
              title={tab.url}
            >
              <span className="browser-tab-title">
                {tab.loading ? '· ' : ''}
                {tab.brokenOut ? '⧉ ' : ''}
                {tab.title || tab.url}
              </span>
              <button
                className="browser-tab-close"
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation()
                  void window.backfile.browserClose(tab.id)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className="tabstrip-actions">
          {active && !active.brokenOut && (
            <button
              className="chip"
              title="Open this tab in its own window"
              onClick={() => window.backfile.browserBreakOut(active.id)}
            >
              ⧉ Break out
            </button>
          )}
          {active && (
            <button
              className="chip"
              title="Open in your default browser"
              onClick={() => window.backfile.openExternal(active.url)}
            >
              Open externally
            </button>
          )}
          <button className="chip" title="Close the browser pane" onClick={onClose}>
            Hide
          </button>
        </div>
      </div>

      {/* The native view is positioned over this element. */}
      <div className="browser-slot" ref={slotRef}>
        {active?.brokenOut && (
          <div className="browser-placeholder">
            This tab is open in its own window. Close that window to bring it back here.
          </div>
        )}
      </div>
    </section>
  )
}
