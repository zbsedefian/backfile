import type { SourceLink } from '../../shared/types'
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
  onRevealLocal: (relativePath: string) => void
}

export function DetailPane({
  link,
  articlePath,
  onToggleExcluded,
  onOpen,
  onOpenExternal,
  onOpenLocal,
  onRevealLocal
}: Props): JSX.Element {
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

      <div className="detail-actions">
        <button className="chip" onClick={() => onOpen(link.url)}>
          Open in pane
        </button>
        <button className="chip" onClick={() => onOpenExternal(link.url)}>
          Open in browser
        </button>
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
          <button className="linklike mono small" onClick={() => onOpen(link.archiveIs)}>
            {link.archiveIs}
          </button>
        ) : (
          <span className="muted small">not captured</span>
        )}
      </div>

      <div className="detail-block">
        <div className="detail-label">Wayback</div>
        {link.wayback ? (
          <button className="linklike mono small" onClick={() => onOpen(link.wayback)}>
            {link.wayback}
          </button>
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
              <button className="chip" onClick={() => onOpenLocal(link.localPath)}>
                Open file
              </button>
              <button className="chip" onClick={() => onRevealLocal(link.localPath)}>
                Show in Finder
              </button>
            </div>
          </>
        ) : (
          <span className="muted small">not captured</span>
        )}
      </div>

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
