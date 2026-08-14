import { useMemo, useState } from 'react'
import type { Article } from '../../shared/types'
import { tierOf } from '../../shared/types'

interface Props {
  root: string | null
  articles: Article[]
  selected: Article | null
  hidden: string[]
  onSelect: (article: Article) => void
  onChooseWorkspace: () => void
  onSetHidden: (names: string[]) => void
  onCreateCollection: (name: string) => void
}

/** Secured means the source has at least the archive.is snapshot that matters. */
function securedCount(article: Article): number {
  return article.sources.filter((l) => {
    if (l.excluded) return true
    const tier = tierOf(l)
    return tier === 'silver' || tier === 'gold'
  }).length
}

export function Sidebar({
  root,
  articles,
  selected,
  hidden,
  onSelect,
  onChooseWorkspace,
  onSetHidden,
  onCreateCollection
}: Props): JSX.Element {
  const [showHidden, setShowHidden] = useState(false)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const commitNew = (): void => {
    const name = newName.trim()
    if (name) onCreateCollection(name)
    setNewName('')
    setCreating(false)
  }

  const hiddenSet = useMemo(() => new Set(hidden), [hidden])

  const listed = useMemo(() => {
    const q = query.trim().toLowerCase()
    return articles.filter((a) => {
      if (!showHidden && hiddenSet.has(a.name)) return false
      return q === '' || a.name.toLowerCase().includes(q)
    })
  }, [articles, hiddenSet, showHidden, query])

  const toggleHidden = (name: string): void => {
    const next = hiddenSet.has(name)
      ? hidden.filter((n) => n !== name)
      : [...hidden, name]
    onSetHidden(next)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-title">Articles</div>
        <button className="btn btn-quiet" onClick={onChooseWorkspace}>
          {root ? 'Change…' : 'Open folder…'}
        </button>
      </div>

      {root && (
        <div className="sidebar-root" title={root}>
          {root}
        </div>
      )}

      {root && (
        <div className="sidebar-search">
          {creating ? (
            <input
              className="input"
              autoFocus
              placeholder="Collection name, then Enter"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={commitNew}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitNew()
                if (e.key === 'Escape') {
                  setNewName('')
                  setCreating(false)
                }
              }}
            />
          ) : (
            <button className="btn btn-wide" onClick={() => setCreating(true)}>
              + New collection
            </button>
          )}
        </div>
      )}

      {articles.length > 0 && (
        <div className="sidebar-search">
          <input
            className="input"
            placeholder="Filter…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      <div className="sidebar-list">
        {listed.length === 0 && (
          <div className="empty-hint">
            {root
              ? articles.length === 0
                ? 'No folders with documents or link lists found here.'
                : 'Nothing matches.'
              : 'Open the folder that holds your article folders.'}
          </div>
        )}

        {listed.map((article) => {
          const total = article.sources.length
          const secured = securedCount(article)
          const complete = total > 0 && secured === total
          const isHidden = hiddenSet.has(article.name)
          return (
            <div
              key={article.path}
              className={`article-row${selected?.path === article.path ? ' is-selected' : ''}${
                isHidden ? ' is-hidden-article' : ''
              }`}
              onClick={() => onSelect(article)}
            >
              <div className="article-row-top">
                <div className="article-name">{article.name}</div>
                <button
                  className="article-hide"
                  title={isHidden ? 'Treat as an article again' : 'Not an article — hide it'}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleHidden(article.name)
                  }}
                >
                  {isHidden ? '+' : '×'}
                </button>
              </div>
              <div className="article-meta">
                {total === 0 ? (
                  <span className="muted">
                    {article.documents.length} file
                    {article.documents.length === 1 ? '' : 's'} · not analyzed
                  </span>
                ) : (
                  <span className={complete ? 'ok' : 'muted'}>
                    {secured}/{total} secured
                  </span>
                )}
              </div>
              {total > 0 && (
                <div className="progress">
                  <div
                    className={`progress-fill${complete ? ' is-complete' : ''}`}
                    style={{ width: `${Math.round((secured / total) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {hidden.length > 0 && (
        <button className="sidebar-foot" onClick={() => setShowHidden((v) => !v)}>
          {showHidden ? 'Hide' : 'Show'} {hidden.length} excluded folder
          {hidden.length === 1 ? '' : 's'}
        </button>
      )}
    </aside>
  )
}
