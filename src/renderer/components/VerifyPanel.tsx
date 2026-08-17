import type { VerificationReport, VerifiedEntry } from '../../main/evidence/manifest'

interface Props {
  report: VerificationReport | null
  checking: boolean
  onClose: () => void
  onRecheck: () => void
}

const STATUS_LABEL: Record<VerifiedEntry['status'], string> = {
  ok: 'Matches',
  modified: 'Modified',
  missing: 'Missing',
  unreadable: 'Unreadable'
}

/**
 * The result of re-hashing every capture the manifest records.
 *
 * Deliberately shows the whole list, not just the failures — a project with
 * two hundred captures and one mismatch is exactly the case where "which one"
 * matters more than "how many", and the answer has to be findable without
 * scrolling past a wall of failures to confirm the rest are fine.
 */
export function VerifyPanel({ report, checking, onClose, onRecheck }: Props): JSX.Element {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 className="modal-title">Verify captures</h2>
          <button className="icon-toggle" onClick={onClose} title="Close">
            ×
          </button>
        </header>

        <div className="modal-body">
          {checking ? (
            <p className="muted">Re-hashing every capture in the manifest…</p>
          ) : !report ? (
            <p className="muted">Nothing checked yet.</p>
          ) : !report.manifestExists ? (
            <p className="muted">
              This project has no manifest yet. Choose Evidence › Update Manifest, then verify.
            </p>
          ) : report.total === 0 ? (
            <p className="muted">The manifest records no captures yet.</p>
          ) : (
            <>
              <p className={report.failures.length === 0 ? 'muted' : undefined}>
                {report.ok}/{report.total} match the manifest.
                {report.modified > 0 && ` ${report.modified} modified.`}
                {report.missing > 0 && ` ${report.missing} missing.`}
                {report.unreadable > 0 && ` ${report.unreadable} unreadable.`}
              </p>
              <ul className="failure-list">
                {report.entries.map((e) => (
                  <li key={e.file} className="failure-row">
                    <div className="failure-row-head">
                      <span className={`pill${e.status !== 'ok' ? ' pill-danger' : ''}`}>
                        {STATUS_LABEL[e.status]}
                      </span>
                      <span className="mono small">{e.file}</span>
                    </div>
                    {e.status === 'modified' && (
                      <div className="failure-message">
                        Recorded <span className="mono">{e.expected.slice(0, 16)}…</span>, now{' '}
                        <span className="mono">{e.actual?.slice(0, 16)}…</span>
                      </div>
                    )}
                    {e.detail && <div className="failure-message">{e.detail}</div>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <footer className="modal-foot">
          <button className="btn btn-quiet" onClick={onRecheck} disabled={checking}>
            Re-check
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  )
}
