import type { RewritePlan } from '../../main/docx/rewriteLinks'

interface Props {
  plan: RewritePlan
  writing: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Shows exactly what publishing will change, before it changes anything.
 *
 * Rewriting a journalist's citations is not something to discover after the
 * fact, and the unarchived list matters as much as the rewritten one: those are
 * the links that will still rot in the published piece.
 */
export function PublishPreview({ plan, writing, onConfirm, onCancel }: Props): JSX.Element {
  const total = plan.changes.reduce((sum, c) => sum + c.occurrences, 0)

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 className="modal-title">Publish archived copy</h2>
          <button className="icon-toggle" onClick={onCancel} title="Close">
            ×
          </button>
        </header>

        <div className="modal-summary">
          <p>
            Writes a new file, <strong>{plan.outputName}</strong>, beside the original.{' '}
            <span className="muted">
              {plan.documentName} itself is not modified. Only the link targets change — the
              visible wording stays exactly as written.
            </span>
          </p>
          {plan.overwrites && (
            <p className="field-hint">
              ⚠ <strong>{plan.outputName}</strong> already exists and will be replaced. If you
              have edited that copy since it was written, those edits are lost.
            </p>
          )}
          <div className="counts">
            <span className="count ok">
              {plan.changes.length} link{plan.changes.length === 1 ? '' : 's'} repointed
              {total !== plan.changes.length && ` (${total} occurrences)`}
            </span>
            {plan.unarchived.length > 0 && (
              <span className="count count-none">
                {plan.unarchived.length} still unarchived
              </span>
            )}
          </div>
        </div>

        <div className="modal-body">
          {plan.changes.length === 0 && (
            <div className="empty-hint">
              Nothing to repoint yet — none of the cited links have a snapshot. Capture some
              first, then publish.
            </div>
          )}

          {plan.changes.map((change) => (
            <div key={change.url} className="change-row">
              <div className="change-from" title={change.url}>
                {change.anchorText && <span className="anchor">“{change.anchorText}”</span>}
                <span className="mono small muted">{change.url}</span>
              </div>
              <div className="change-to">
                <span className="arrow">→</span>
                <span className="mono small">{change.snapshot}</span>
                {change.service === 'wayback' && (
                  <span
                    className="pill"
                    title="No archive.is snapshot exists, so the Wayback URL is used. Wayback can resolve to a different capture over time."
                  >
                    wayback
                  </span>
                )}
                {change.occurrences > 1 && <span className="pill">×{change.occurrences}</span>}
              </div>
            </div>
          ))}

          {plan.unarchived.length > 0 && (
            <details className="unarchived">
              <summary>
                {plan.unarchived.length} cited link
                {plan.unarchived.length === 1 ? '' : 's'} with no snapshot — these will publish
                unchanged and can still rot
              </summary>
              {plan.unarchived.map((url) => (
                <div key={url} className="mono small muted change-unarchived">
                  {url}
                </div>
              ))}
            </details>
          )}
        </div>

        <footer className="modal-foot">
          <button className="btn btn-quiet" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={onConfirm}
            disabled={writing || plan.changes.length === 0}
          >
            {writing ? 'Writing…' : plan.overwrites ? 'Replace it' : `Write ${plan.outputName}`}
          </button>
        </footer>
      </div>
    </div>
  )
}
