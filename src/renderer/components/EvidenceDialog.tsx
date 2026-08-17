import { useState } from 'react'
import { DEFAULT_TSA_URL } from '../../shared/evidence'

interface Props {
  currentUrl: string
  saving: boolean
  onSave: (url: string) => void
  onCancel: () => void
}

/**
 * Where RFC 3161 timestamp requests go.
 *
 * A native menu radio picks the scheme (see the Evidence menu), but "which
 * authority" is free text, not a fixed list — a newsroom's counsel may have
 * already chosen one, or a firm may run its own internal TSA — so it needs an
 * actual field to type into rather than another menu item.
 */
export function EvidenceDialog({ currentUrl, saving, onSave, onCancel }: Props): JSX.Element {
  const [url, setUrl] = useState(currentUrl || DEFAULT_TSA_URL)

  const submit = (): void => {
    if (url.trim()) onSave(url.trim())
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal-narrow" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 className="modal-title">RFC 3161 timestamp authority</h2>
          <button className="icon-toggle" onClick={onCancel} title="Close">
            ×
          </button>
        </header>

        <div className="modal-body">
          <label className="field">
            <span className="field-label">Authority URL</span>
            <input
              className="input mono"
              autoFocus
              placeholder={DEFAULT_TSA_URL}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && url.trim()) submit()
              }}
            />
            <span className="field-hint">
              Every local and video capture submits its SHA-256 here and stores the returned
              token beside the capture. Only the hash is sent — never the URL, page, or article.
              Defaults to {DEFAULT_TSA_URL}, a free public authority, if left blank.
            </span>
          </label>
        </div>

        <footer className="modal-foot">
          <button className="btn btn-quiet" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={saving || !url.trim()} onClick={submit}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  )
}
