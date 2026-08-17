/**
 * Read and write an article's sources.csv.
 *
 * This file is the source of truth, not a cache: it lives in the article's own
 * folder, opens in Excel, diffs cleanly in git, and survives Backfile being
 * uninstalled. That constraint is why the parser here is a real RFC 4180
 * implementation rather than a split on commas — URLs carry commas, and
 * journalists' notes carry quotes and newlines.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { LinkStatus, SourceLink, tierOf } from '../../shared/types'

export const SOURCES_FILENAME = 'sources.csv'

/** Column order is chosen for a human opening this in Excel: status first. */
const COLUMNS = [
  'status',
  'title',
  'url',
  'anchor_text',
  'archive_is',
  'wayback',
  'local_path',
  'video_path',
  'screenshot_path',
  'captured_at',
  'last_checked_at',
  'link_status',
  'verified_by',
  'found_in',
  'article_source',
  'excluded',
  'excluded_reason',
  'notes'
] as const

const LINK_STATUSES: ReadonlySet<string> = new Set<LinkStatus>([
  'ok',
  'redirected',
  'notfound',
  'servererror',
  'timeout',
  'unreachable',
  'blocked'
])

const TIER_LABEL: Record<string, string> = {
  none: '',
  bronze: 'bronze',
  silver: 'silver',
  gold: 'gold'
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  // Strip a UTF-8 BOM; Excel writes one and it would poison the first header.
  if (text.charCodeAt(0) === 0xfeff) i = 1

  for (; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      // Treat CRLF as one terminator.
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else {
      field += c
    }
  }
  // A trailing field only counts as a row if the file did not end on a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function escapeField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

export function serializeCsv(links: SourceLink[]): string {
  const lines = [COLUMNS.join(',')]
  for (const link of links) {
    const record: Record<(typeof COLUMNS)[number], string> = {
      status: TIER_LABEL[tierOf(link)] ?? '',
      title: link.title,
      url: link.url,
      anchor_text: link.anchorText,
      archive_is: link.archiveIs,
      wayback: link.wayback,
      local_path: link.localPath,
      video_path: link.videoPath,
      screenshot_path: link.screenshotPath,
      captured_at: link.capturedAt,
      last_checked_at: link.lastCheckedAt,
      link_status: link.linkStatus,
      verified_by: link.verifiedBy,
      found_in: link.foundIn.join('; '),
      article_source: link.articleSource.join('; '),
      excluded: link.excluded ? 'yes' : '',
      excluded_reason: link.excludedReason,
      notes: link.notes
    }
    lines.push(COLUMNS.map((c) => escapeField(record[c])).join(','))
  }
  // Trailing newline keeps the file POSIX-clean and git-diff friendly.
  return lines.join('\n') + '\n'
}

export function rowsToLinks(rows: string[][]): SourceLink[] {
  if (rows.length === 0) return []
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const idx = (name: string): number => header.indexOf(name)
  const at = (row: string[], name: string): string => {
    const i = idx(name)
    return i >= 0 && i < row.length ? row[i].trim() : ''
  }

  const links: SourceLink[] = []
  for (const row of rows.slice(1)) {
    // Skip blank lines rather than emitting a phantom source with an empty URL.
    if (row.every((c) => c.trim() === '')) continue
    const url = at(row, 'url')
    if (!url) continue
    links.push({
      url,
      title: at(row, 'title'),
      anchorText: at(row, 'anchor_text'),
      foundIn: at(row, 'found_in')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean),
      articleSource: at(row, 'article_source')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean),
      archiveIs: at(row, 'archive_is'),
      wayback: at(row, 'wayback'),
      localPath: at(row, 'local_path'),
      videoPath: at(row, 'video_path'),
      screenshotPath: at(row, 'screenshot_path'),
      capturedAt: at(row, 'captured_at'),
      lastCheckedAt: at(row, 'last_checked_at'),
      // A CSV a hand-editor mangled defaults to "unchecked" rather than
      // carrying a status string the rest of the app does not recognise.
      linkStatus: (LINK_STATUSES.has(at(row, 'link_status')) ? at(row, 'link_status') : '') as
        | LinkStatus
        | '',
      verifiedBy: (['auto', 'human'].includes(at(row, 'verified_by'))
        ? at(row, 'verified_by')
        : '') as SourceLink['verifiedBy'],
      notes: at(row, 'notes'),
      excluded: /^(yes|true|1)$/i.test(at(row, 'excluded')),
      excludedReason: at(row, 'excluded_reason')
    })
  }
  return links
}

export async function readSources(articlePath: string): Promise<SourceLink[]> {
  const file = path.join(articlePath, SOURCES_FILENAME)
  try {
    const text = await fs.readFile(file, 'utf8')
    return rowsToLinks(parseCsv(text))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

export async function writeSources(articlePath: string, links: SourceLink[]): Promise<void> {
  const file = path.join(articlePath, SOURCES_FILENAME)
  // A unique temp name per write. Callers are serialised by a lock, but a
  // shared "sources.csv.tmp" makes two overlapping writes actively destructive
  // rather than merely racy: one renames the file away while the other is still
  // depending on it, and the second write dies with ENOENT.
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    // Write-then-rename so an interrupted save can never truncate existing work.
    await fs.writeFile(tmp, serializeCsv(links), 'utf8')
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}
