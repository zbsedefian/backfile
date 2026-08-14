import { useEffect, useState } from 'react'
import type { ServiceId, SourceLink } from '../../shared/types'
import { isLikelyVideoPage } from '../../shared/links'
import { TierBadge } from './Tier'

interface Props {
  link: SourceLink | null
  articlePath: string
  onToggleExcluded: (url: string, excluded: boolean) => void
  /** Open in the embedded pane. */
  onOpen: (url: string) => void
  /** Open in the system browser. */
  onOpenExternal: (url: string) => void
  onOpenLocal: (relativePath: string) => void
  onViewLocal: (relativePath: string) => void
  onRevealLocal: (relativePath: string) => void
  onEditUrl: (oldUrl: string, newUrl: string) => void
  onDelete: (url: string) => void
  /** Discard a recorded capture and run it again. */
  onRecapture: (url: string, service: ServiceId) => void
  recapturing: string | null
}

export function DetailPane({
  link,
  articlePath,
  onToggleExcluded,
  onOpen,
  onOpenExternal,
  onOpenLocal,
  onViewLocal,
  onRevealLocal,
  onEditUrl,
  onDelete,
  onRecapture,
  recapturing
}: Props): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draftUrl, setDraftUrl] = useState('')
  // Removal is one click next to several harmless ones, so it asks first.
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  // Leave edit mode when the selection changes, so a half-typed URL is never
  // applied to a different source than the one it was typed for.
  useEffect(() => {
    setEditing(false)
    setConfirmingDelete(false)
    setDraftUrl(link?.url ?? '')
  }, [link?.url])

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
            link.foundIn.map((d) => (
              <div key={d} className="mono small">
                {d}
              </div>
            ))
          ) : (
            <span className="muted">
              No longer in any draft — kept because the snapshot still matters.
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
        <div className="detail-label">Local copy</div>
        {link.localPath ? (
          <>
            <button
              className="linklike mono small"
              title={`${articlePath}/${link.localPath}`}
              onClick={() => onOpenLocal(link.localPath)}
            >
              {link.localPath}
            </button>
            <div className="detail-actions">
              {/* Chromium reads MHTML natively, which is why captures are saved
                  in it — the OS often has nothing that will open one. */}
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

      {(link.videoPath || isLikelyVideoPage(link.url)) && (
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
              This is a video page. A local copy saves the title and description but not the
              video itself, which is streamed separately \u2014 use Capture all \u203a Video, which
              needs yt-dlp installed.
            </span>
          )}
        </div>
      )}

      {link.capturedAt && (
        <div className="detail-block">
          <div className="detail-label">Last capture</div>
          <div className="detail-value mono small">{link.capturedAt}</div>
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
