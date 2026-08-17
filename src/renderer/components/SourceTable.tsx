import { useMemo, useState } from 'react'
import type { ServiceId, SourceLink } from '../../shared/types'
import { linkOutcome, tierOf } from '../../shared/types'
import type { ClickModifiers } from '../../shared/selection'
import { TierBadge } from './Tier'
import { ResizeHandle } from './ResizeHandle'

const COL_TIER_WIDTH = 30
const COL_SVC_WIDTH = 92
/** archive.is, local, wayback, video, captured. */
const SERVICE_COLUMN_COUNT = 5

export type SortKey = 'tier' | 'source' | 'captured'
export interface Sort {
  key: SortKey
  dir: 'asc' | 'desc'
}

/** Ordering for the tier column: least archived first, so gaps surface. */
const TIER_RANK: Record<string, number> = { none: 0, bronze: 1, silver: 2, gold: 3 }

/**
 * What each unverified outcome means, for the pill's tooltip.
 *
 * Deliberately hedged — none of these assert the page is gone, only that an
 * automated check could not confirm it resolves. A redirect to the homepage,
 * a timeout, a server error and an unreachable host are all just as
 * plausibly bot-detection blocking the check as they are real link rot; see
 * linkOutcome's own doc comment in shared/types.ts for why only a 404 is
 * shown with any certainty.
 */
const UNVERIFIED_LABEL: Record<string, string> = {
  redirected: 'Redirects to the site’s homepage — may be gone, may be a bot check. Worth a manual look.',
  servererror: 'Returned an error when checked automatically — could be down, or could be blocking the check.',
  timeout: 'Timed out when checked automatically — could be down, slow, or blocking the check.',
  unreachable: 'Could not be reached when checked automatically — could be gone, or the check itself failed.'
}

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
    [l.url, l.title, l.anchorText, l.notes, l.foundIn.join(' ')].some((field) =>
      field.toLowerCase().includes(q)
    )
  )
}

interface Props {
  links: SourceLink[]
  /** Every selected row. Usually one; more after a cmd- or shift-click. */
  selectedUrls: string[]
  /** The one row the detail pane follows. */
  focusedUrl: string | null
  busy: Record<string, boolean>
  onSelect: (url: string, mods: ClickModifiers) => void
  onCapture: (url: string, service: ServiceId) => void
  onOpen: (url: string) => void
  /** Finished snapshots open in the real browser, not the embedded pane. */
  onOpenExternal: (url: string) => void
  /** A local MHTML capture opens in Backfile's own pane — see ServiceCell. */
  onViewLocal: (relativePath: string) => void
  /** A downloaded video opens with whatever the OS plays media files with. */
  onOpenLocal: (relativePath: string) => void
  /** A human looked at a flagged source themselves and it's fine — clears the flag. */
  onResolveLinkCheck: (url: string) => void
  sort: Sort
  onSortChange: (sort: Sort) => void
  /** Non-empty when a search is filtering the list, for a truthful empty state. */
  query: string
  /** Overrides the default no-sources copy when the caller knows a better reason. */
  emptyHint?: string
  /**
   * Width of the Source column in pixels. The table uses a fixed layout so
   * this is authoritative — without it, a single long anchor-text quote or URL
   * forces the whole table wider than the window, pushing the capture buttons
   * out past the right edge until the window is maximised or the list scrolled
   * sideways to reach them.
   */
  sourceColWidth: number
  onSourceColWidthChange: (width: number) => void
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
  selectedUrls,
  focusedUrl,
  busy,
  onSelect,
  onCapture,
  onOpen,
  onOpenExternal,
  onViewLocal,
  onOpenLocal,
  onResolveLinkCheck,
  sort,
  onSortChange,
  query,
  emptyHint,
  sourceColWidth,
  onSourceColWidthChange
}: Props): JSX.Element {
  const selectedSet = useMemo(() => new Set(selectedUrls), [selectedUrls])
  const tableWidth = COL_TIER_WIDTH + sourceColWidth + SERVICE_COLUMN_COUNT * COL_SVC_WIDTH

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
        ) : emptyHint ? (
          // The list can be empty for reasons the default copy would get
          // wrong — a sources.csv full of rows hidden because no document is
          // imported yet, say. The caller knows why; let it say so.
          <p className="muted">{emptyHint}</p>
        ) : (
          <>
            <p>No sources recorded yet.</p>
            <p className="muted">
              Press “Add article” to import a document and read every URL it cites, or “+ Add
              link” to record one by hand.
            </p>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="table-wrap">
      <table className="source-table" style={{ width: tableWidth }}>
        <colgroup>
          <col className="col-tier" />
          <col style={{ width: sourceColWidth }} />
          <col className="col-svc" />
          <col className="col-svc" />
          <col className="col-svc" />
          <col className="col-svc" />
          <col className="col-svc" />
        </colgroup>
        <thead>
          <tr>
            <th className="col-tier sortable" onClick={() => toggleSort('tier')} title="Sort by archival status">
              ★{caret('tier')}
            </th>
            <th className="col-url col-url-head sortable" onClick={() => toggleSort('source')}>
              Source{caret('source')}
              <div
                className="col-resize-handle"
                // Stops a drag (or even a plain click) on the handle from also
                // toggling the sort, since both live on the same header cell.
                onClick={(e) => e.stopPropagation()}
              >
                <ResizeHandle
                  orientation="vertical"
                  onDelta={(delta) => onSourceColWidthChange(sourceColWidth + delta)}
                  title="Drag to resize the Source column"
                />
              </div>
            </th>
            <th className="col-svc" title="archive.is — an on-demand snapshot service; usually the single most useful archive for a citation">
              archive.is
            </th>
            {/* Local before Wayback: a self-contained file on disk is the
                second most valuable thing to have, ahead of a submission to a
                service this app does not control. */}
            <th className="col-svc" title="A self-contained copy of the page saved onto this computer, inside this article's own folder">
              Local
            </th>
            <th className="col-svc" title="The Wayback Machine, run by the Internet Archive — a second, independent backup of the page">
              Wayback
            </th>
            <th className="col-svc" title="The actual video file, downloaded via yt-dlp if the source has one — a local copy alone only saves the page around it, not the video itself">
              Video
            </th>
            <th className="col-svc sortable" onClick={() => toggleSort('captured')} title="When this source was last archived by any of the services above — sort by it">
              Captured{caret('captured')}
            </th>
          </tr>
        </thead>
        <tbody>
          {links.map((link) => {
            const { host, rest } = displayUrl(link.url)
            const selected = selectedSet.has(link.url)
            const focused = focusedUrl === link.url
            const outcome = linkOutcome(link)
            return (
              <tr
                key={link.url}
                data-url={link.url}
                className={`${selected ? 'is-selected' : ''}${focused ? ' is-focused' : ''}`}
                // Shift-clicking a range would otherwise leave the browser's own
                // blue text selection smeared across every row it crossed.
                onMouseDown={(e) => {
                  if (e.shiftKey) e.preventDefault()
                }}
                onClick={(e) =>
                  onSelect(link.url, { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey })
                }
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
                    {/* The headline is what identifies a citation at a glance;
                        the bare path rarely says anything at all. */}
                    {link.title && (
                      <span className="url-title" title={link.title}>
                        {link.title}
                      </span>
                    )}
                    {link.excluded && <span className="pill">excluded</span>}
                    {outcome === 'gone' && (
                      <button
                        className="pill pill-rotted pill-button"
                        title="The original URL now returns 404. Click to open it in your browser — if it's actually fine, this clears the flag."
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpenExternal(link.url)
                          onResolveLinkCheck(link.url)
                        }}
                      >
                        NOT FOUND
                      </button>
                    )}
                    {outcome === 'unverified' && (
                      <button
                        className="pill pill-unverified pill-button"
                        title={`${
                          UNVERIFIED_LABEL[link.linkStatus] ?? 'Could not confirm this page still resolves.'
                        } Click to open it in your browser — if it's actually fine, this clears the flag.`}
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpenExternal(link.url)
                          onResolveLinkCheck(link.url)
                        }}
                      >
                        unverified
                      </button>
                    )}
                    <CopyLinkButton url={link.url} />
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
                  service="local"
                  value={link.localPath}
                  busy={busy[busyKey(link.url, 'local')]}
                  onCapture={onCapture}
                  onOpen={onOpen}
                  onOpenExternal={onOpenExternal}
                  onViewLocal={onViewLocal}
                  actionLabel="Download"
                  isFile
                  viewInPane
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
                  service="video"
                  value={link.videoPath}
                  busy={busy[busyKey(link.url, 'video')]}
                  onCapture={onCapture}
                  onOpen={onOpen}
                  onOpenExternal={onOpenExternal}
                  onViewLocal={onOpenLocal}
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
  /** The value is a file path relative to the article folder, not a URL. */
  isFile?: boolean
  /**
   * Only meaningful when isFile is set. A local MHTML capture opens in
   * Backfile's own pane — Chromium reads MHTML natively, and the OS handoff
   * that every other file goes through sometimes lands on Word, which cannot
   * open a Chromium MHTML's stylesheet parts and fails with a wall of
   * unreadable "Missing file: cid:css-…" errors. A video file has no such
   * trap, so it takes the ordinary OS handoff instead.
   */
  viewInPane?: boolean
  /** True when this service does not apply to this row at all, rather than
   *  merely "not captured yet". */
  notApplicable?: boolean
  onCapture: (url: string, service: ServiceId) => void
  onOpen: (url: string) => void
  onOpenExternal: (url: string) => void
  onViewLocal?: (relativePath: string) => void
}

function ServiceCell({
  link,
  service,
  value,
  busy,
  actionLabel,
  isFile,
  viewInPane,
  notApplicable,
  onCapture,
  onOpenExternal,
  onViewLocal
}: CellProps): JSX.Element {
  if (link.excluded || notApplicable) {
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
            title={isFile ? `${viewInPane ? 'View' : 'Open'} ${value}` : `Open ${value} in your browser`}
            onClick={(e) => {
              e.stopPropagation()
              if (isFile) onViewLocal?.(value)
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

const COPIED_FLASH_MS = 1300

/**
 * Copies the full URL, not the trimmed host shown in the row — the truncated
 * display is for scanning the list, and pasting a shortened link elsewhere
 * would send someone to the wrong page.
 */
function CopyLinkButton({ url }: { url: string }): JSX.Element {
  const [copied, setCopied] = useState(false)

  return (
    <button
      className={`copy-link${copied ? ' is-copied' : ''}`}
      title={copied ? 'Copied' : `Copy ${url}`}
      onClick={(e) => {
        e.stopPropagation()
        void window.backfile.copyText(url)
        setCopied(true)
        setTimeout(() => setCopied(false), COPIED_FLASH_MS)
      }}
    >
      {copied ? '✓' : '⧉'}
    </button>
  )
}
