/**
 * The domain model, shared verbatim between the Electron main process and the
 * renderer. Everything here maps 1:1 onto a row of an article's sources.csv so
 * the file on disk stays the source of truth, not a hidden database.
 */

/** Which archives a source has, expressed the way it is shown in the UI. */
export type ArchiveTier = 'none' | 'bronze' | 'silver' | 'gold'

/** The independent places a source can be preserved. */
export type ServiceId = 'archiveIs' | 'wayback' | 'local' | 'video'

/**
 * Outcome of the most recent link-rot check against a source's original URL.
 *
 * `redirected` means specifically a redirect to a bare homepage — the shape a
 * removed or reorganised article takes almost every time — not any redirect
 * at all. A domain move or an https upgrade still lands on `ok`.
 */
export type LinkStatus =
  | 'ok'
  | 'redirected'
  | 'notfound'
  | 'servererror'
  | 'timeout'
  | 'unreachable'
  /**
   * Something loaded, but it was not the article — a bot wall or an error
   * page. Distinct from the outcomes above because those describe what the
   * server said, while this one describes a page Backfile actually rendered
   * and then failed to recognise as the source.
   */
  | 'blocked'

export interface SourceLink {
  /** The original URL as it appeared in the document. */
  url: string
  /** The clickable text the URL was behind, when it had any. */
  anchorText: string
  /**
   * The page's own headline, read from a capture rather than the network.
   *
   * A list of bare URLs is unreadable at a glance — nytimes.com/2026/05/05/…
   * says nothing about which citation it is. The title comes from the local
   * copy: Backfile already loads the page in a real browser to save it, so the
   * headline is there for free, and reading it back later needs nothing but the
   * file on disk.
   */
  title: string
  /** Names of the .docx files this URL was found in (an article has drafts). */
  foundIn: string[]
  /**
   * Which imported document(s) this row belongs to, for filtering.
   *
   * Populated the same way as `foundIn` — every document an "Add article"
   * import found this URL in — but kept as its own field because `foundIn`
   * also drives orphan detection, and a future reason to filter by source
   * (e.g. a document that stops citing a link but should still "own" it for
   * filtering) should not have to fight that logic to do it. Empty for a link
   * added by hand, which has no source document.
   */
  articleSource: string[]
  /** Permanent archive.today/archive.is snapshot, captured by hand. */
  archiveIs: string
  /** Wayback Machine snapshot. Optional by design — off unless asked for. */
  wayback: string
  /** Path of the local capture, relative to the article folder. */
  localPath: string
  /**
   * Path of a downloaded video, relative to the article folder.
   *
   * Separate from localPath because they preserve different things: an MHTML
   * capture of a YouTube page keeps the title, channel and description but
   * cannot keep the video, which is streamed separately and is usually the
   * only part that actually matters.
   */
  videoPath: string
  /**
   * Path of a screenshot taken alongside the local capture, relative to the
   * article folder.
   *
   * MHTML opens like a page, not like a snapshot — telling two captures of the
   * same URL apart, months later, means actually opening each one. A
   * thumbnail answers that at a glance.
   */
  screenshotPath: string
  /** ISO timestamp of the most recent successful capture. */
  capturedAt: string
  /** Free-text, for the journalist. Never written to by the app. */
  notes: string
  /**
   * Deliberately not archived. DOI, JSTOR and publisher links resolve
   * permanently on their own, so chasing snapshots for them is busywork.
   */
  excluded: boolean
  /** Why it was excluded, when it was. */
  excludedReason: string
  /** ISO timestamp of the most recent link-rot check. Empty until checked. */
  lastCheckedAt: string
  /** Outcome of the most recent link-rot check. Empty until checked. */
  linkStatus: LinkStatus | ''
  /**
   * Who established `linkStatus` — an automated check, or a person who
   * watched the page load in the pane.
   *
   * Recorded because a re-check would otherwise undo human verification on
   * exactly the sources that needed it: a bot wall answers the automated
   * check the same way every run, so a source a journalist confirmed by hand
   * would fall straight back to unverified on the next pass, forever. See
   * overridesExisting in main/health/checkLinks.ts for what this protects.
   */
  verifiedBy: 'auto' | 'human' | ''
}

export interface Article {
  /** Folder name, e.g. "CAM_01_Brave1-Market". */
  name: string
  /** Absolute path to the article folder. */
  path: string
  /** Every document in the folder, excluding Word's ~$ lock files. */
  documents: string[]
  /**
   * The subset of `documents` confirmed to be the journalist's own drafts.
   * Only these are analysed; the rest are reference material that happens to
   * live in the same folder.
   */
  drafts: string[]
  /** Populated once sources.csv has been read. */
  sources: SourceLink[]
  /** True when the folder has a sources.csv yet to be created. */
  hasSourcesFile: boolean
}

export interface CaptureRequest {
  articlePath: string
  url: string
  service: ServiceId
}

export interface CaptureResult {
  ok: boolean
  service: ServiceId
  url: string
  /** Snapshot URL, or the local file path for a local capture. */
  value?: string
  /** The page's headline, when the capture loaded the page and so knows it. */
  title?: string
  /** Path of a screenshot taken alongside a local capture, when there is one. */
  screenshotPath?: string
  error?: string
}

/** Hosts whose links are permanent citations already and need no snapshot. */
export const PERMANENT_HOSTS = [
  'doi.org',
  'dx.doi.org',
  'link.springer.com',
  'jstor.org',
  'www.jstor.org',
  'pubmed.ncbi.nlm.nih.gov',
  'arxiv.org'
] as const

export function isPermanentCitation(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return PERMANENT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  } catch {
    return false
  }
}

/**
 * A source is stranded when the only documents citing it are ones no longer
 * ticked as drafts — a downloaded reference piece, say, whose links were pulled
 * in before anyone said it was not a draft.
 *
 * Kept as one definition because the list, the pending counts, "capture all"
 * and the sidebar progress bar all have to agree about it. If the sidebar says
 * 103 sources and the list shows 58, the number nobody trusts is both of them.
 *
 * A source with no citing document at all is not stranded: that is a hand-added
 * link, or one an editor cut, and both belong to the journalist.
 */
export function isStranded(link: SourceLink, drafts: string[]): boolean {
  if (link.foundIn.length === 0) return false
  const ticked = new Set(drafts)
  return !link.foundIn.some((d) => ticked.has(d))
}

/**
 * How confidently the last link-rot check says something is wrong with a
 * source's original URL — null if it has not been checked, or checked clean.
 *
 * Only a 404 counts as `gone`: the server itself said the page no longer
 * exists. Every other non-clean result a plain request can produce — a
 * redirect to the homepage, a timeout, a server error, an unreachable host —
 * is just as often bot-detection blocking an automated check as it is real
 * link rot, so it is surfaced as merely `unverified` rather than asserted as
 * dead. See checkLinks.ts's own doc comment for why a plain request cannot
 * reliably tell the two apart.
 *
 * Excluded links never produce either outcome — DOI and repository links
 * resolve permanently by design, so a link-rot check has nothing to tell a
 * journalist about one, the same reasoning that keeps them off the tier
 * ladder in tierOf below.
 */
export type LinkOutcome = 'gone' | 'unverified'

export function linkOutcome(link: SourceLink): LinkOutcome | null {
  if (link.excluded || link.linkStatus === '' || link.linkStatus === 'ok') return null
  return link.linkStatus === 'notfound' ? 'gone' : 'unverified'
}

/** The sources an article still claims as its own. */
export function ownSources(article: Pick<Article, 'sources' | 'drafts'>): SourceLink[] {
  return article.sources.filter((l) => !isStranded(l, article.drafts))
}

/**
 * Bronze is a local copy only, silver adds the archive.is snapshot that most
 * citations actually need, gold is all three. Excluded links sit outside the
 * ladder entirely and report as gold so they stop nagging.
 */
export function tierOf(link: SourceLink): ArchiveTier {
  if (link.excluded) return 'gold'
  // A downloaded video counts as the local copy: for a video page it is the
  // only thing that actually preserves what was cited.
  const has = [!!link.archiveIs, !!link.wayback, !!link.localPath || !!link.videoPath]
  const count = has.filter(Boolean).length
  if (count === 0) return 'none'
  if (has[0] && has[1] && has[2]) return 'gold'
  if (has[0]) return 'silver'
  return 'bronze'
}
