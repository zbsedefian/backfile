import type { ServiceId, SourceLink } from '../../shared/types'
import { tierOf } from '../../shared/types'
import { TierBadge } from './Tier'

export type SortKey = 'tier' | 'source' | 'captured'
export interface Sort {
  key: SortKey
  dir: 'asc' | 'desc'
}

/** Ordering for the tier column: least archived first, so gaps surface. */
const TIER_RANK: Record<string, number> = { none: 0, bronze: 1, silver: 2, gold: 3 }

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function sortLinks(links: SourceLink[], sort: Sort): SourceLink[] {
  const factor = sort.dir === 'asc' ? 1 : -1
  return [...links].sort((a, b) => {
    switch (sort.key) {
      case 'tier': {
        const rank = (l: SourceLink): number => (l.excluded ? 4 : TIER_RANK[tierOf(l)])
        const diff = rank(a) - rank(b)
        // Ties fall back to host so repeated sorts are stable and readable.
        return (diff !== 0 ? diff : hostOf(a.url).localeCompare(hostOf(b.url))) * factor
      }
      case 'captured':
        return (a.capturedAt || '').localeCompare(b.capturedAt || '') * factor
      case 'source':
      default:
        return (
          (hostOf(a.url).localeCompare(hostOf(b.url)) || a.url.localeCompare(b.url)) * factor
        )
    }
  })
}

export function filterLinks(links: SourceLink[], query: string): SourceLink[] {
  const q = query.trim().toLowerCase()
  if (!q) return links
  return links.filter((l) =>
    [l.url, l.anchorText, l.notes, l.foundIn.join(' ')].some((field) =>
      field.toLowerCase().includes(q)
    )
  )
}

interface Props {
  links: SourceLink[]
  selectedUrl: string | null
  busy: Record<string, boolean>
  onSelect: (url: string) => void
  onCapture: (url: string, service: ServiceId) => void
  onOpen: (url: string) => void
  /** Finished snapshots open in the real browser, not the embedded pane. */
  onOpenExternal: (url: string) => void
  onOpenLocal: (relativePath: string) => void
  sort: Sort
  onSortChange: (sort: Sort) => void
  /** Non-empty when a search is filtering the list, for a truthful empty state. */
  query: string
}

export function busyKey(url: string, service: ServiceId): string {
  return `${service}::${url}`
}

/** Show the host and a trimmed path — full URLs are unreadable at table width. */
function displayUrl(url: string): { host: string; rest: string } {
  try {
    const u = new URL(url)
    const rest = `${u.pathname}${u.search}`.replace(/\/$/, '')
    return { host: u.hostname.replace(/^www\./, ''), rest: rest === '' ? '/' : rest }
  } catch {
    return { host: url, rest: '' }
  }
}

export function SourceTable({
  links,
  selectedUrl,
  busy,
  onSelect,
  onCapture,
  onOpen,
  onOpenExternal,
  onOpenLocal,
  sort,
  onSortChange,
  query
}: Props): JSX.Element {
  const toggleSort = (key: SortKey): void => {
    onSortChange(
      sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
    )
  }
  const caret = (key: SortKey): string =>
    sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''

  if (links.length === 0) {
    return (
      <div className="empty-state">
        {query ? (
          <>
            <p>Nothing matches “{query}”.</p>
            <p className="muted">Clear the search to see every source again.</p>
          </>
        ) : (
          <>
            <p>No sources recorded yet.</p>
            <p className="muted">
              Run “Analyze links” to pull every URL out of this article’s drafts and link lists.
            </p>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="table-wrap">
      <table className="source-table">
        <thead>
          <tr>
            <th className="col-tier sortable" onClick={() => toggleSort('tier')} title="Sort by archival status">
              ★{caret('tier')}
            </th>
            <th className="col-url sortable" onClick={() => toggleSort('source')}>
              Source{caret('source')}
            </th>
            <th className="col-svc">archive.is</th>
            <th className="col-svc">Wayback</th>
            <th className="col-svc">Local</th>
            <th className="col-svc sortable" onClick={() => toggleSort('captured')}>
              Captured{caret('captured')}
            </th>
          </tr>
        </thead>
        <tbody>
          {links.map((link) => {
            const { host, rest } = displayUrl(link.url)
            const selected = selectedUrl === link.url
            return (
              <tr
                key={link.url}
                data-url={link.url}
                className={selected ? 'is-selected' : ''}
                onClick={() => onSelect(link.url)}
              >
                <td className="col-tier">
                  <TierBadge link={link} />
                </td>
                <td className="col-url">
                  <div className="url-host">
                    <button
                      className="linklike"
                      title={`Open ${link.url}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpen(link.url)
                      }}
                    >
                      {host}
                    </button>
                    {link.excluded && <span className="pill">excluded</span>}
                  </div>
                  <div className="url-rest" title={link.url}>
                    {link.anchorText ? `“${link.anchorText}” · ` : ''}
                    {rest}
                  </div>
                </td>

                <ServiceCell
                  link={link}
                  service="archiveIs"
                  value={link.archiveIs}
                  busy={busy[busyKey(link.url, 'archiveIs')]}
                  onCapture={onCapture}
                  onOpen={onOpen}
                  onOpenExternal={onOpenExternal}
                  actionLabel="Capture"
                />
                <ServiceCell
                  link={link}
                  service="wayback"
                  value={link.wayback}
                  busy={busy[busyKey(link.url, 'wayback')]}
                  onCapture={onCapture}
                  onOpen={onOpen}
                  onOpenExternal={onOpenExternal}
                  actionLabel="Save"
                />
                <ServiceCell
                  link={link}
                  service="local"
                  value={link.localPath}
                  busy={busy[busyKey(link.url, 'local')]}
                  onCapture={onCapture}
                  onOpen={onOpen}
                  onOpenExternal={onOpenExternal}
                  onOpenLocal={onOpenLocal}
                  actionLabel="Download"
                  isFile
                />
                <td className="col-svc">
                  <span className="muted small mono">
                    {link.capturedAt ? link.capturedAt.slice(0, 10) : '—'}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

interface CellProps {
  link: SourceLink
  service: ServiceId
  value: string
  busy?: boolean
  actionLabel: string
  isFile?: boolean
  onCapture: (url: string, service: ServiceId) => void
  onOpen: (url: string) => void
  onOpenExternal: (url: string) => void
  onOpenLocal?: (relativePath: string) => void
}

function ServiceCell({
  link,
  service,
  value,
  busy,
  actionLabel,
  isFile,
  onCapture,
  onOpenExternal,
  onOpenLocal
}: CellProps): JSX.Element {
  if (link.excluded) {
    return (
      <td className="col-svc">
        <span className="muted small">n/a</span>
      </td>
    )
  }
  if (value) {
    return (
      <td className="col-svc">
        <span className="chip-pair">
          <button
            className="chip chip-done"
            title={isFile ? `Open ${value}` : `Open ${value} in your browser`}
            onClick={(e) => {
              e.stopPropagation()
              // A local capture is a file path, so it is opened by the OS. A
              // finished snapshot opens in the real browser rather than the
              // embedded pane — it is a result to read, not a page to work in.
              if (isFile) onOpenLocal?.(value)
              else onOpenExternal(value)
            }}
          >
            ✓
          </button>
          {/* A capture can be of the wrong page, a paywall, or a cookie wall,
              and until now there was no way to take another one. */}
          <button
            className="chip chip-recapture"
            disabled={busy}
            title="Capture this again and replace the recorded one"
            onClick={(e) => {
              e.stopPropagation()
              onCapture(link.url, service)
            }}
          >
            {busy ? '…' : '↻'}
          </button>
        </span>
      </td>
    )
  }
  return (
    <td className="col-svc">
      <button
        className="chip"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation()
          onCapture(link.url, service)
        }}
      >
        {busy ? '…' : actionLabel}
      </button>
    </td>
  )
}
