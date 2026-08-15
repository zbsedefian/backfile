import { useEffect, useRef, useState } from 'react'

interface Props {
  /** Every document imported into this article, in import order. */
  articles: string[]
  /** The one currently narrowing the list, or null for "every article". */
  value: string | null
  onChange: (value: string | null) => void
  /** Undo a mistaken import — the only way to correct one, since import never asks twice. */
  onRemove: (name: string) => void
}

/**
 * Which imported document's sources are being looked at.
 *
 * An article folder can hold more than one imported document — a draft and a
 * later revision, say — and each source row records which import it came
 * from. This is how that becomes something you can actually narrow down to,
 * rather than a column of filenames nobody can act on.
 */
export function ArticleSourceMenu({ articles, value, onChange, onRemove }: Props): JSX.Element {
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

  const choose = (next: string | null): void => {
    setOpen(false)
    onChange(next)
  }

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        className="btn"
        disabled={articles.length === 0}
        onClick={() => setOpen(!open)}
        title={
          articles.length === 0
            ? 'Import a document with "Add article" to filter by it'
            : 'Show only the sources from one imported document'
        }
      >
        {value ?? 'All articles'} {open ? '▴' : '▾'}
      </button>

      {open && (
        <div className="menu menu-wide">
          <button className="menu-item" onClick={() => choose(null)}>
            <span className="menu-item-label">All articles</span>
          </button>

          {articles.length > 0 && <div className="menu-rule" />}

          {articles.map((name) => (
            <div key={name} className="menu-item-removable">
              <button className="menu-item-main" onClick={() => choose(name)} title={name}>
                <span className="menu-item-label">{name}</span>
              </button>
              <button
                className="menu-item-remove"
                title={`Remove ${name} — its sources stay in sources.csv, findable under "orphaned"`}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen(false)
                  onRemove(name)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
