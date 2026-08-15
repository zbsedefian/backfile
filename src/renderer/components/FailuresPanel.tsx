import { useState } from 'react'
import type { CaptureFailure } from '../App'

interface Props {
  failures: CaptureFailure[]
  onClose: () => void
  onClear: () => void
}

const SOURCE_LABEL: Record<CaptureFailure['source'], string> = {
  archiveIs: 'archive.is',
  wayback: 'Wayback',
  local: 'Local copy',
  video: 'Video',
  analyze: 'Analyze links',
  publish: 'Export'
}

/** Plain text, meant to be pasted whole into a bug report or a chat message. */
export function formatFailureReport(failures: CaptureFailure[]): string {
  const lines = [`Backfile — ${failures.length} failure${failures.length === 1 ? '' : 's'}`, '']
  for (const f of failures) {
    lines.push(`[${new Date(f.at).toLocaleString()}] ${SOURCE_LABEL[f.source]}`)
    if (f.url) lines.push(f.url)
    lines.push(f.message, '')
  }
  return lines.join('\n').trimEnd()
}

/**
 * Every capture, analyze and publish failure, kept in one place.
 *
 * A status-bar toast is one line that the next status message erases, so a
 * batch run with three failures scattered through twenty sources left only
 * the last one visible by the time the run finished — and no way to hand it
 * to anyone else without retyping it from memory. This keeps the whole run's
 * worth of failures, in order, each with its own message and a button to copy
 * it verbatim.
 */
export function FailuresPanel({ failures, onClose, onClear }: Props): JSX.Element {
  const [copiedAll, setCopiedAll] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const copyAll = (): void => {
    void window.backfile.copyText(formatFailureReport(failures))
    setCopiedAll(true)
    setTimeout(() => setCopiedAll(false), 1500)
  }

  const copyOne = (f: CaptureFailure): void => {
    void window.backfile.copyText([f.url, f.message].filter(Boolean).join('\n'))
    setCopiedId(f.id)
    setTimeout(() => setCopiedId((id) => (id === f.id ? null : id)), 1500)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 className="modal-title">
            {failures.length} failure{failures.length === 1 ? '' : 's'}
          </h2>
          <button className="icon-toggle" onClick={onClose} title="Close">
            ×
          </button>
        </header>

        <div className="modal-body">
          {failures.length === 0 ? (
            <p className="muted">Nothing has failed since this was last cleared.</p>
          ) : (
            <ul className="failure-list">
              {failures.map((f) => (
                <li key={f.id} className="failure-row">
                  <div className="failure-row-head">
                    <span className="pill">{SOURCE_LABEL[f.source]}</span>
                    <span className="muted small">{new Date(f.at).toLocaleTimeString()}</span>
                    <button
                      className="btn btn-quiet failure-copy"
                      onClick={() => copyOne(f)}
                      title="Copy this failure"
                    >
                      {copiedId === f.id ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  {f.url && (
                    <div className="mono small failure-url" title={f.url}>
                      {f.url}
                    </div>
                  )}
                  <div className="failure-message">{f.message}</div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="modal-foot">
          <button
            className="btn btn-quiet failure-clear"
            onClick={onClear}
            disabled={failures.length === 0}
          >
            Clear
          </button>
          <button className="btn" onClick={copyAll} disabled={failures.length === 0}>
            {copiedAll ? 'Copied' : 'Copy all'}
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  )
}
