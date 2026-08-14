/**
 * Recognising pasted links.
 *
 * Pure logic, deliberately in shared/ rather than beside the file-writing code:
 * the Add-link dialog needs it to explain what it is about to do, and the
 * renderer must never import a module that reaches for node:fs.
 */

/** Snapshot URL shapes we can recognise when a link is pasted in. */
const ARCHIVE_IS =
  /^https?:\/\/archive\.(?:ph|is|today|li|vn|md|fo)\/(?:wip\/)?([A-Za-z0-9]{4,12})\/?$/i
const WAYBACK = /^https?:\/\/web\.archive\.org\/web\/(\d+)(?:[a-z_]+)?\/(https?:\/\/.+)$/i

/**
 * Query parameters that identify who shared a link rather than what it points
 * at. Stripping them means the same article shared three ways collapses into
 * one source, and the archived snapshot is of the clean address.
 *
 * Deliberately an explicit list rather than a pattern. Plenty of short,
 * innocuous-looking parameters are load-bearing — "?v=" is the entire identity
 * of a YouTube video, "?p=" and "?id=" address content on countless CMSs — so
 * anything not known to be tracking is left alone.
 */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'twclid',
  'yclid',
  'igshid',
  'igsh',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'vero_id',
  'vero_conv',
  'oly_anon_id',
  'oly_enc_id',
  'mkt_tok',
  'trk',
  'trkCampaign',
  'sc_campaign',
  'sc_channel',
  'sc_content',
  'sc_medium',
  'sc_outcome',
  'ref_src',
  'ref_url',
  'spm',
  'scm'
])

/**
 * Parameters that are tracking on specific hosts but may be load-bearing
 * elsewhere. "si" is the share identifier YouTube and Spotify append when you
 * copy a link, and stripping it everywhere would be exactly the overreach this
 * module is meant to avoid.
 */
const HOST_SCOPED_TRACKING: Record<string, string[]> = {
  'youtube.com': ['si', 'pp', 'feature'],
  'youtu.be': ['si', 'feature'],
  'spotify.com': ['si'],
  'open.spotify.com': ['si']
}

/** Strip tracking noise from a URL without touching parameters that address content. */
export function cleanTrackingParams(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return raw
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  const scoped = new Set(
    Object.entries(HOST_SCOPED_TRACKING)
      .filter(([h]) => host === h || host.endsWith(`.${h}`))
      .flatMap(([, keys]) => keys)
  )

  let changed = false
  for (const key of [...parsed.searchParams.keys()]) {
    const lower = key.toLowerCase()
    if (
      lower.startsWith('utm_') ||
      TRACKING_PARAMS.has(key) ||
      TRACKING_PARAMS.has(lower) ||
      scoped.has(lower)
    ) {
      parsed.searchParams.delete(key)
      changed = true
    }
  }
  if (!changed) return raw

  // Drop a now-empty "?" so the cleaned URL matches how it would be typed.
  const search = parsed.searchParams.toString()
  parsed.search = search ? `?${search}` : ''
  return parsed.toString()
}

/**
 * The single normalisation used everywhere a URL is recorded, compared or
 * rewritten. Extraction, manual entry and the .docx rewriter all route through
 * this, because if any two of them disagree the rewriter silently stops
 * matching links it should have repointed.
 */
export function normalizeUrl(raw: string): string {
  let out = raw.trim().replace(/[.,;:]+$/, '')
  // Drop a closing paren only when nothing opened it, e.g. "(see https://x.com/a)".
  if (out.endsWith(')') && !out.includes('(')) out = out.slice(0, -1)
  return cleanTrackingParams(out)
}

/**
 * Hosts whose pages stream their media separately from the page itself.
 *
 * This matters because an MHTML capture of one of these preserves the title,
 * channel and description and a dead player — everything except the video,
 * which is usually the only part being cited. Flagging them is the difference
 * between a journalist knowing they still need the footage and believing they
 * already archived it.
 */
const VIDEO_HOSTS = [
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'dailymotion.com',
  'tiktok.com',
  'rumble.com',
  'odysee.com',
  'twitch.tv',
  'bitchute.com',
  'streamable.com'
]

export function isLikelyVideoPage(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    return VIDEO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  } catch {
    return false
  }
}

export interface ParsedPaste {
  /** The original source URL, when it could be determined. */
  url: string
  archiveIs: string
  wayback: string
  /** True when only a snapshot was given and the original is still unknown. */
  snapshotOnly: boolean
}

/**
 * Work out what someone just pasted.
 *
 * A Wayback URL carries the original inside it, so it can be split apart
 * perfectly. An archive.is short link does not — the original exists only on
 * the page itself. That is not a failure: an archive.is address is already
 * permanent, so it is worth saving on its own terms.
 */
export function parsePastedLink(raw: string): ParsedPaste {
  const input = raw.trim()

  const wayback = WAYBACK.exec(input)
  if (wayback) {
    return { url: wayback[2], archiveIs: '', wayback: input, snapshotOnly: false }
  }

  const archiveIs = ARCHIVE_IS.exec(input)
  if (archiveIs) {
    // Normalise away the /wip/ form, which is the in-progress view of a capture
    // and stops resolving once the snapshot finishes.
    const canonical = `https://archive.ph/${archiveIs[1]}`
    return { url: '', archiveIs: canonical, wayback: '', snapshotOnly: true }
  }

  return { url: input, archiveIs: '', wayback: '', snapshotOnly: false }
}
