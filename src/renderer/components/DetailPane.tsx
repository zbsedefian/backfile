import { useEffect, useState } from 'react'
import type { ServiceId, SourceLink } from '../../shared/types'
import { describeAge, isStaleCheck } from '../../shared/age'
import { TierBadge } from './Tier'

interface Props {
  link: SourceLink | null
  articlePath: string
  /** Which of the article's documents currently count as drafts. */
  drafts: string[]
  onToggleExcluded: (url: string, excluded: boolean) => void
  /** Open in the embedded pane. */
  onOpen: (url: string) => void
  /** Open in the system browser. */
  onOpenExternal: (url: string) => void
  onOpenLocal: (relativePath: string) => void
  onViewLocal: (relativePath: string) => void
  onRevealLocal: (relativePath: string) => void
  onEditUrl: (oldUrl: string, newUrl: string) => void
  onEditTitle: (url: string, title: string) => void
  onDelete: (url: string) => void
  /** Discard a recorded capture and run it again. */
  onRecapture: (url: string, service: ServiceId) => void
  recapturing: string | null
  /** Build a printable, self-explanatory PDF record of this source's captures. */
  onGenerateReport: (url: string) => void
  generatingReport: boolean
}

export function DetailPane({
  link,
  articlePath,
  drafts,
  onToggleExcluded,
  onOpen,
  onOpenExternal,
  onOpenLocal,
  onViewLocal,
  onRevealLocal,
  onEditUrl,
  onEditTitle,
  onDelete,
  onRecapture,
  recapturing,
  onGenerateReport,
  generatingReport
}: Props): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draftUrl, setDraftUrl] = useState('')
  const [draftTitle, setDraftTitle] = useState('')
  // Removal is one click next to several harmless ones, so it asks first.
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [screenshot, setScreenshot] = useState<string | null>(null)

  // Leave edit mode when the selection changes, so a half-typed URL is never
  // applied to a different source than the one it was typed for. Title synced
  // the same way: only when the row itself changes, not on every re-render, so
  // a background refresh can never interrupt someone mid-keystroke.
  useEffect(() => {
    setEditing(false)
    setConfirmingDelete(false)
    setDraftUrl(link?.url ?? '')
    setDraftTitle(link?.title ?? '')
  }, [link?.url])

  // Read via IPC rather than a "file:" src: the renderer's CSP only allows
  // "data:" images, which is the point — a captured page's own assets never
  // get a path the renderer could load directly.
  useEffect(() => {
    setScreenshot(null)
    if (!link?.screenshotPath || !articlePath) return
    let cancelled = false
    void window.backfile.readScreenshot(articlePath, link.screenshotPath).then((dataUrl) => {
      if (!cancelled) setScreenshot(dataUrl)
    })
    return () => {
      cancelled = true
    }
  }, [articlePath, link?.screenshotPath])

  if (!link) {
    return (
      <section className="detail">
        <div className="empty-hint">Select a source to see its archival record.</div>
      </section>
    )
  }

  return (
    <section className="detail">
      <div className="detail-head">
        <TierBadge link={link} />
        <button
          className="linklike detail-url"
          title="Open in the browser pane"
          onClick={() => onOpen(link.url)}
        >
          {link.url}
        </button>
      </div>

      {editing ? (
        <div className="field">
          <input
            className="input"
            autoFocus
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onEditUrl(link.url, draftUrl)
                setEditing(false)
              }
              if (e.key === 'Escape') {
                setDraftUrl(link.url)
                setEditing(false)
              }
            }}
          />
          <div className="detail-actions">
            <button
              className="chip"
              onClick={() => {
                onEditUrl(link.url, draftUrl)
                setEditing(false)
              }}
            >
              Save
            </button>
            <button
              className="chip"
              onClick={() => {
                setDraftUrl(link.url)
                setEditing(false)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="detail-actions">
          <button className="chip" onClick={() => onOpen(link.url)}>
            Open in pane
          </button>
          <button className="chip" onClick={() => onOpenExternal(link.url)}>
            Open in browser
          </button>
          <button className="chip" onClick={() => setEditing(true)} title="Correct this URL">
            Edit URL
          </button>
          {confirmingDelete ? (
            <>
              <button className="chip chip-danger" onClick={() => onDelete(link.url)}>
                Really remove
              </button>
              <button className="chip" onClick={() => setConfirmingDelete(false)}>
                Keep
              </button>
            </>
          ) : (
            <button
              className="chip chip-danger"
              title="Remove this source from the collection. Captured files are left on disk."
              onClick={() => setConfirmingDelete(true)}
            >
              Remove
            </button>
          )}
        </div>
      )}

      <div className="detail-block">
        <div className="detail-label">Title</div>
        <input
          className="input"
          value={draftTitle}
          placeholder="e.g. an x.com post has no headline of its own to read back"
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={() => {
            if (draftTitle !== link.title) onEditTitle(link.url, draftTitle)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setDraftTitle(link.title)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
      </div>

      {link.anchorText && (
        <div className="detail-block">
          <div className="detail-label">Cited as</div>
          <div className="detail-value">“{link.anchorText}”</div>
        </div>
      )}

      <div className="detail-block">
        <div className="detail-label">Found in</div>
        <div className="detail-value">
          {link.foundIn.length > 0 ? (
            link.foundIn.map((d) => {
              const imported = drafts.includes(d)
              return (
                <div key={d} className="mono small" title={imported ? undefined : `${d} is not imported — this source stays hidden from the working views until the document is imported with “Add article” or the source is removed`}>
                  {d}
                  {!imported && <span className="pill">not imported</span>}
                </div>
              )
            })
          ) : (
            <span className="muted">
              N/A
            </span>
          )}
        </div>
      </div>

      <div className="detail-block">
        <div className="detail-label">archive.is</div>
        {link.archiveIs ? (
          <>
            <button className="linklike mono small" onClick={() => onOpen(link.archiveIs)}>
              {link.archiveIs}
            </button>
            <div className="detail-actions">
              <button
                className="chip"
                disabled={recapturing === 'archiveIs'}
                title="Discard this snapshot and capture it again"
                onClick={() => onRecapture(link.url, 'archiveIs')}
              >
                {recapturing === 'archiveIs' ? 'Capturing…' : 'Re-capture'}
              </button>
            </div>
          </>
        ) : (
          <span className="muted small">not captured</span>
        )}
      </div>

      <div className="detail-block">
        <div className="detail-label">Local copy</div>
        {link.localPath ? (
          <>
            <button
              className="linklike mono small"
              title={`${articlePath}/${link.localPath}`}
              onClick={() => onViewLocal(link.localPath)}
            >
              {link.localPath}
            </button>
            <div className="detail-actions">
              {/* Chromium reads MHTML natively, which is why captures are saved
                  in it. "Open externally" hands the file to whatever the OS has
                  registered for the extension instead, which on macOS is
                  sometimes Word — and Word cannot open a Chromium MHTML's
                  stylesheet parts, failing with a wall of unreadable
                  "Missing file: cid:css-…" errors. So the filename and the
                  primary chip both go through the pane; externally stays one
                  click away for whoever actually wants it. */}
              <button className="chip" onClick={() => onViewLocal(link.localPath)}>
                View here
              </button>
              <button className="chip" onClick={() => onOpenLocal(link.localPath)}>
                Open externally
              </button>
              <button className="chip" onClick={() => onRevealLocal(link.localPath)}>
                Show in Finder
              </button>
              <button
                className="chip"
                disabled={recapturing === 'local'}
                onClick={() => onRecapture(link.url, 'local')}
              >
                {recapturing === 'local' ? 'Capturing…' : 'Re-capture'}
              </button>
            </div>
          </>
        ) : (
          <span className="muted small">not captured</span>
        )}
      </div>

      <div className="detail-block">
        <div className="detail-label">Wayback</div>
        {link.wayback ? (
          <>
            <button className="linklike mono small" onClick={() => onOpen(link.wayback)}>
              {link.wayback}
            </button>
            <div className="detail-actions">
              <button
                className="chip"
                disabled={recapturing === 'wayback'}
                onClick={() => onRecapture(link.url, 'wayback')}
              >
                {recapturing === 'wayback' ? 'Capturing…' : 'Re-capture'}
              </button>
            </div>
          </>
        ) : (
          <span className="muted small">not captured</span>
        )}
      </div>

      <div className="detail-block">
        <div className="detail-label">Video</div>
        {link.videoPath ? (
          <>
            <span className="mono small">{link.videoPath}</span>
            <div className="detail-actions">
              <button className="chip" onClick={() => onOpenLocal(link.videoPath)}>
                Play
              </button>
              <button className="chip" onClick={() => onRevealLocal(link.videoPath)}>
                Show in Finder
              </button>
              <button
                className="chip"
                disabled={recapturing === 'video'}
                title="Download it again, replacing the existing file"
                onClick={() => onRecapture(link.url, 'video')}
              >
                {recapturing === 'video' ? 'Downloading…' : 'Re-download'}
              </button>
            </div>
          </>
        ) : (
          <span className="muted small">
            not captured — Capture all › Video downloads the actual video, if this page has
            one, via yt-dlp. A local copy alone cannot capture it, since it streams separately
            from the page.
          </span>
        )}
      </div>

      {link.capturedAt && (
        <div className="detail-block">
          <div className="detail-label">Last capture</div>
          <div className="detail-value mono small">{link.capturedAt}</div>
        </div>
      )}

      {link.lastCheckedAt && (
        <div className="detail-block">
          <div className="detail-label">Link checked</div>
          <div className="detail-value small">
            <span className="mono">{link.lastCheckedAt.slice(0, 10)}</span>{' '}
            <span className={isStaleCheck(link.lastCheckedAt) ? 'warn' : 'muted'}>
              ({describeAge(link.lastCheckedAt)})
            </span>
            {/* Said out loud because a hand verification is the one kind that
                cannot refresh itself: the wall that made it necessary answers
                every future automated check exactly the same way, so its age
                is the only thing that distinguishes it from a fresh result. */}
            {link.verifiedBy === 'human' && (
              <div className="muted small">
                Verified by hand. Automated re-checks will not overturn this
                unless the page has genuinely gone.
              </div>
            )}
          </div>
        </div>
      )}

      {link.screenshotPath && (
        <div className="detail-block">
          <div className="detail-label">Screenshot</div>
          {screenshot ? (
            <>
              <img className="screenshot-thumb" src={screenshot} alt="" />
              <div className="detail-actions">
                <button className="chip" onClick={() => onRevealLocal(link.screenshotPath)}>
                  Show in Finder
                </button>
              </div>
            </>
          ) : (
            <span className="muted small">not readable</span>
          )}
        </div>
      )}

      {(link.localPath || link.videoPath) && (
        <div className="detail-block">
          <div className="detail-label">Evidence</div>
          <div className="detail-value muted small">
            A printable record of this source — URL, timestamps, hash, screenshot and capture
            method — with instructions for verifying it independently.
          </div>
          <div className="detail-actions">
            <button
              className="chip"
              disabled={generatingReport}
              title="Generate a self-contained PDF suitable for attaching to a filing"
              onClick={() => onGenerateReport(link.url)}
            >
              {generatingReport ? 'Generating…' : 'Capture report (PDF)'}
            </button>
          </div>
        </div>
      )}

      <div className="detail-block">
        <label className="checkline">
          <input
            type="checkbox"
            checked={link.excluded}
            onChange={(e) => onToggleExcluded(link.url, e.target.checked)}
          />
          <span>
            Doesn’t need archiving
            {link.excludedReason && <em className="muted small"> — {link.excludedReason}</em>}
          </span>
        </label>
      </div>
    </section>
  )
}
