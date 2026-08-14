import { useEffect, useRef, useState } from 'react'
import type { ServiceId } from '../../shared/types'

interface Props {
  pending: { archiveIs: number; wayback: number; local: number; video: number }
  videoAvailable: boolean | null
  disabled: boolean
  /** Services with a run already in flight; a second would collide with it. */
  running: ServiceId[]
  onRun: (service: ServiceId) => void
}

/**
 * The capture actions, behind one menu.
 *
 * They were previously four buttons sitting in a row with counts on them, which
 * read as filters — so clicking one to "show archived links" instead launched a
 * long run against every source. Worse, the video button appeared and vanished
 * as counts changed, moving the others under the cursor mid-click.
 *
 * A menu fixes both: the verb is stated once, in the button, and nothing shifts
 * position. Video is separated below a rule because it is the only action that
 * depends on software Backfile does not ship.
 */
export function CaptureMenu({
  pending,
  videoAvailable,
  disabled,
  running,
  onRun
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const choose = (service: ServiceId): void => {
    setOpen(false)
    onRun(service)
  }

  const item = (
    service: ServiceId,
    label: string,
    count: number,
    note: string
  ): JSX.Element => {
    const busy = running.includes(service)
    return (
      <button
        className="menu-item"
        disabled={count === 0 || busy}
        onClick={() => choose(service)}
        title={busy ? 'Already running' : note}
      >
        <span className="menu-item-label">{label}</span>
        <span className={`menu-item-count${count === 0 && !busy ? ' is-done' : ''}`}>
          {busy ? 'running…' : count === 0 ? 'all done' : `${count} left`}
        </span>
      </button>
    )
  }

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        className="btn"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        title="Run a capture across every source that still needs one"
      >
        Capture all… {open ? '▴' : '▾'}
      </button>

      {open && (
        <div className="menu">
          {item(
            'archiveIs',
            'archive.is',
            pending.archiveIs,
            'Runs in the pane below. Expect at most one CAPTCHA for the whole run.'
          )}
          {item(
            'wayback',
            'Wayback Machine',
            pending.wayback,
            'Submits each source to the Internet Archive.'
          )}
          {item(
            'local',
            'Local copies',
            pending.local,
            'Saves a self-contained MHTML file of each page into this article’s folder.'
          )}

          <div className="menu-rule" />

          <button
            className="menu-item"
            disabled={pending.video === 0 || running.includes('video')}
            onClick={() => choose('video')}
            title={
              videoAvailable === false
                ? 'Needs yt-dlp. Install with: brew install yt-dlp'
                : 'Downloads the actual video file. A local copy of a video page cannot capture the video itself.'
            }
          >
            <span className="menu-item-label">
              Videos
              {videoAvailable === false && <span className="pill">needs yt-dlp</span>}
            </span>
            <span className={`menu-item-count${pending.video === 0 ? ' is-done' : ''}`}>
              {running.includes('video')
                ? 'running…'
                : pending.video === 0
                  ? 'none found'
                  : `${pending.video} left`}
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
