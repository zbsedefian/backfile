/**
 * Link extraction from plain-text sources.
 *
 * A .docx is not the only way a link list arrives. Journalists keep them in
 * scratch .txt files, in Markdown notes, and in whatever the last tool spat out.
 *
 * This also understands the `URL === SNAPSHOT` convention produced by hand-rolled
 * archiving scripts, so an existing list of painstakingly captured snapshots is
 * imported as finished work rather than re-queued as work to do.
 */

export interface ExtractedTextLink {
  url: string
  /** A snapshot URL that the file already recorded alongside the source. */
  knownArchive?: string
}

const URL_RE = /https?:\/\/[^\s<>"'\]|)]+/g

function tidy(url: string): string {
  let out = url.trim().replace(/[.,;:]+$/, '')
  if (out.endsWith(')') && !out.includes('(')) out = out.slice(0, -1)
  return out
}

function isArchiveSnapshot(url: string): boolean {
  return /^https?:\/\/(?:archive\.(?:ph|is|today|li|vn|md|fo)|web\.archive\.org)\//i.test(url)
}

export function extractLinksFromText(text: string): ExtractedTextLink[] {
  const byUrl = new Map<string, ExtractedTextLink>()

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    // "original === snapshot" is the shape emitted by manual archiving scripts.
    const separated = line.split('===')
    if (separated.length >= 2) {
      const left = tidy(separated[0].match(URL_RE)?.[0] ?? '')
      const right = tidy(separated.slice(1).join('===').match(URL_RE)?.[0] ?? '')
      // A row pointing at itself means "not captured", not "captured here".
      if (left && right && left !== right && isArchiveSnapshot(right)) {
        byUrl.set(left, { url: left, knownArchive: right })
        continue
      }
      if (left) {
        if (!byUrl.has(left)) byUrl.set(left, { url: left })
        continue
      }
    }

    for (const match of line.match(URL_RE) ?? []) {
      const url = tidy(match)
      // Never file a snapshot as though it were a source in its own right.
      if (!url || isArchiveSnapshot(url)) continue
      if (!byUrl.has(url)) byUrl.set(url, { url })
    }
  }

  return [...byUrl.values()]
}

/** Extensions treated as plain-text link lists. */
export const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.csv.txt'] as const

export function isTextSource(filename: string): boolean {
  const lower = filename.toLowerCase()
  if (lower.startsWith('.') || lower.startsWith('~$')) return false
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))
}
