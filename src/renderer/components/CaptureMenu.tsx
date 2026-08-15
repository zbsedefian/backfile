import { useEffect, useRef, useState } from 'react'
import type { ServiceId } from '../../shared/types'

interface Props {
  pending: { archiveIs: number; wayback: number; local: number; video: number }
  videoAvailable: boolean | null
  disabled: boolean
  /** Services with a run already in flight; a second would collide with it. */
  running: ServiceId[]
  onRun: (service: ServiceId) => void
  onInstallYtDlp: () => void
  installingYtDlp: boolean
  /** Bytes received so far, once a download is in progress. */
  installProgress: { receivedBytes: number; totalBytes: number | null } | null
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
/** Human-readable byte count, coarse enough that a download's progress reads at a glance. */
function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function CaptureMenu({
  pending,
  videoAvailable,
  disabled,
  running,
  onRun,
  onInstallYtDlp,
  installingYtDlp,
  installProgress
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
            'local',
            'Local copies',
            pending.local,
            'Saves a self-contained MHTML file of each page into this article’s folder.'
          )}
          {item(
            'wayback',
            'Wayback Machine',
            pending.wayback,
            'Submits each source to the Internet Archive.'
          )}

          <div className="menu-rule" />

          {videoAvailable === false ? (
            // A dead-end tooltip ("install with brew") is no help to a
            // journalist who has never opened a terminal — this fetches
            // yt-dlp's own published binary directly, no package manager
            // required, and stays disabled until the install actually lands
            // so a slow connection cannot be double-clicked into two at once.
            <button
              className="menu-item"
              disabled={installingYtDlp}
              onClick={(e) => {
                e.stopPropagation()
                onInstallYtDlp()
              }}
              title="Downloads yt-dlp's own binary from github.com/yt-dlp/yt-dlp (about 20 MB) into Backfile's own folder — not a system-wide install, and nothing else changes."
            >
              <span className="menu-item-label">
                Install yt-dlp
                <span className="pill">needed for video</span>
              </span>
              <span className="menu-item-count">
                {installingYtDlp
                  ? installProgress
                    ? `${formatBytes(installProgress.receivedBytes)}${
                        installProgress.totalBytes
                          ? ` / ${formatBytes(installProgress.totalBytes)}`
                          : ''
                      }`
                    : 'starting…'
                  : 'click to install'}
              </span>
            </button>
          ) : (
            item(
              'video',
              'Videos',
              pending.video,
              'Downloads the actual video file for each source that has one, via yt-dlp. ' +
                'A local copy alone cannot capture it, since it streams separately from the page.'
            )
          )}
        </div>
      )}
    </div>
  )
}
