import { useMemo, useState } from 'react'
import { parsePastedLink } from '../../shared/links'

interface Props {
  articleName: string
  saving: boolean
  onSave: (input: { url: string; archiveIs: string; wayback: string; notes: string }) => void
  onCancel: () => void
}

/**
 * Add a link by hand.
 *
 * Kept to one field on purpose. Most of the time someone has a link and wants
 * it saved — that is the whole interaction, and asking which of three archival
 * fields it belongs in would be interrogating them about their own bookmark.
 *
 * Recognition happens quietly underneath: a Wayback URL carries the original
 * inside it and gets split, an archive.is link is already a permanent address
 * so it counts as its own snapshot, and anything else is just a source.
 */
export function AddSourceDialog({ articleName, saving, onSave, onCancel }: Props): JSX.Element {
  const [link, setLink] = useState('')
  const [notes, setNotes] = useState('')
  const [showMore, setShowMore] = useState(false)
  const [archiveIs, setArchiveIs] = useState('')
  const [wayback, setWayback] = useState('')

  const parsed = useMemo(() => (link.trim() ? parsePastedLink(link) : null), [link])

  const summary = useMemo(() => {
    if (!parsed) return null
    if (parsed.wayback && parsed.url) return 'Wayback snapshot — saved with its original URL.'
    if (parsed.snapshotOnly) return 'An archive.is link, which is already permanent. Saved as archived.'
    return null
  }, [parsed])

  const submit = (): void => {
    onSave({
      url: link.trim(),
      archiveIs: archiveIs.trim(),
      wayback: wayback.trim(),
      notes: notes.trim()
    })
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal-narrow" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 className="modal-title">Add a link to {articleName}</h2>
          <button className="icon-toggle" onClick={onCancel} title="Close">
            ×
          </button>
        </header>

        <div className="modal-body">
          <label className="field">
            <span className="field-label">Link</span>
            <input
              className="input"
              autoFocus
              placeholder="https://…"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && link.trim()) submit()
              }}
            />
            {summary && <span className="field-hint ok">{summary}</span>}
          </label>

          <label className="field">
            <span className="field-label">Notes (optional)</span>
            <input
              className="input"
              placeholder="Why this matters, where it came from…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && link.trim()) submit()
              }}
            />
          </label>

          <button className="disclosure" onClick={() => setShowMore(!showMore)}>
            {showMore ? '▾' : '▸'} I already have snapshots of this
          </button>

          {showMore && (
            <>
              <label className="field">
                <span className="field-label">archive.is snapshot</span>
                <input
                  className="input"
                  placeholder="https://archive.ph/XXXXX"
                  value={archiveIs}
                  onChange={(e) => setArchiveIs(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Wayback snapshot</span>
                <input
                  className="input"
                  placeholder="https://web.archive.org/web/…"
                  value={wayback}
                  onChange={(e) => setWayback(e.target.value)}
                />
              </label>
            </>
          )}
        </div>

        <footer className="modal-foot">
          <button className="btn btn-quiet" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={saving || !link.trim()} onClick={submit}>
            {saving ? 'Saving…' : 'Add link'}
          </button>
        </footer>
      </div>
    </div>
  )
}
