/**
 * The domain model, shared verbatim between the Electron main process and the
 * renderer. Everything here maps 1:1 onto a row of an article's sources.csv so
 * the file on disk stays the source of truth, not a hidden database.
 */

/** Which archives a source has, expressed the way it is shown in the UI. */
export type ArchiveTier = 'none' | 'bronze' | 'silver' | 'gold'

/** The independent places a source can be preserved. */
export type ServiceId = 'archiveIs' | 'wayback' | 'local' | 'video'

export interface SourceLink {
  /** The original URL as it appeared in the document. */
  url: string
  /** The clickable text the URL was behind, when it had any. */
  anchorText: string
  /** Names of the .docx files this URL was found in (an article has drafts). */
  foundIn: string[]
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
}

export interface Article {
  /** Folder name, e.g. "CAM_01_Brave1-Market". */
  name: string
  /** Absolute path to the article folder. */
  path: string
  /** Every .docx in the folder, excluding Word's ~$ lock files. */
  documents: string[]
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
