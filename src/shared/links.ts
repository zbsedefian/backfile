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
