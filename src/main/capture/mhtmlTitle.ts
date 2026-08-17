/**
 * Read a page's headline back out of a saved MHTML capture.
 *
 * Captures made before Backfile recorded titles still have one sitting in the
 * file, and re-fetching those pages to learn something already on disk would be
 * both slower and a request to a publisher for no reason. So the title is
 * recovered locally.
 *
 * Chromium writes the HTML part as quoted-printable, which breaks long lines
 * with a trailing "=" and escapes bytes as "=XX". A title long enough to be
 * useful is usually long enough to be split across one of those breaks, so the
 * encoding has to be undone before looking for the tag rather than after.
 */

/** Enough of the file to hold the <head>, without reading a 5MB capture. */
export const TITLE_SCAN_BYTES = 512 * 1024

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“'
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

function decodeQuotedPrintable(text: string): string {
  // Soft line breaks first: they can fall in the middle of an =XX sequence.
  const joined = text.replace(/=\r?\n/g, '')
  const bytes: number[] = []
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i]
    if (ch === '=' && /^[0-9a-f]{2}$/i.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16))
      i += 2
      continue
    }
    // Anything not escaped is already a literal character. Encoding it back to
    // UTF-8 keeps multi-byte sequences intact when the buffer is decoded.
    const code = ch.charCodeAt(0)
    if (code < 0x80) bytes.push(code)
    else bytes.push(...new TextEncoder().encode(ch))
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes))
}

/**
 * The title a bot check, a cookie wall or an error page hands back in place of
 * the real headline.
 *
 * Shared with link verification in ../health/verifyPage: the question "is this
 * the actual page, or the wall in front of it?" is the same one whether it is
 * being asked of a saved capture or of a live tab a journalist is looking at,
 * and two copies of this list would drift apart.
 */
const PLACEHOLDER_TITLE =
  /^(just a moment|attention required|access denied|are you a robot|error|not found|403 forbidden|redirecting|loading|one moment|please wait|security check|verify you are human)\b/i

export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_TITLE.test(title.replace(/\s+/g, ' ').trim())
}

/**
 * Titles are noisy: publishers append their own name, and a capture of a
 * cookie wall or an error page is worse than no title at all.
 */
function tidy(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim()
  if (clean.length === 0 || clean.length > 300) return ''
  if (isPlaceholderTitle(clean)) return ''
  return clean
}

export function extractTitleFromMhtml(chunk: string): string {
  // The quoted-printable pass is what makes a wrapped title readable; a capture
  // written as plain 8-bit passes through it unchanged.
  const decoded = decodeQuotedPrintable(chunk)
  const match = /<title[^>]*>([\s\S]{0,600}?)<\/title>/i.exec(decoded)
  if (!match) return ''
  return tidy(decodeEntities(match[1]))
}
