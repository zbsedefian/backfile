/**
 * Which documents in a folder are the journalist's own drafts.
 *
 * Not every document in an article folder is a draft. Reference material gets
 * downloaded into the same place all the time — a rival's piece, a court filing,
 * a PDF-turned-docx someone emailed — and analysing one of those files every
 * link it contains into sources.csv, where they are indistinguishable from
 * links the journalist actually cited.
 *
 * So inclusion is a decision, and the record of it is a list of chosen
 * filenames per folder, built by explicitly importing one document at a time
 * ("Add article"). A folder starts with none — nothing is adopted just because
 * it happens to be sitting in the same directory.
 *
 * That list is kept in Backfile's own settings file, keyed by folder path,
 * which means it outlives the folder's contents: moving sources.csv aside to
 * start a piece over leaves the settings entry behind, and the folder reopens
 * still claiming to have imported documents nobody imported this time round.
 * Then the next "Add article" — which is additive — analyses that whole
 * inherited set, and links from a document the journalist never picked land in
 * the fresh sources.csv. So sources.csv is treated as the evidence that the
 * imports are real: without it there is no project here yet, whatever settings
 * remembers about the last one.
 */

export type DraftIndex = Record<string, string[]>

export interface Resolution {
  /** The documents to analyse, in `documents` order. */
  drafts: string[]
  /** The index entry this folder should now have, or null to leave it alone. */
  record: string[] | null
}

export function resolveDrafts(
  articlePath: string,
  documents: string[],
  index: DraftIndex,
  /** Whether the folder still has the sources.csv those imports produced. */
  hasSourcesFile: boolean
): Resolution {
  const known = index[articlePath] ?? []

  // Every import writes sources.csv, so its absence means the imports this
  // entry describes belong to a project that is no longer here — renamed,
  // moved aside, or deleted to start over. Honouring the entry anyway would
  // re-analyse documents the journalist has not picked since, which is how
  // links from an unimported draft end up in a brand-new sources.csv.
  if (!hasSourcesFile) {
    return { drafts: [], record: known.length > 0 ? [] : null }
  }

  // Chosen files can be renamed or deleted outside Backfile, so the stored list
  // is filtered against what is really on disk rather than trusted outright.
  const chosen = new Set(known)
  const drafts = documents.filter((d) => chosen.has(d))

  // Prune names that no longer exist, so a folder churning through imports does
  // not accumulate a settings entry full of ghosts. A rename looks like a
  // deletion plus a not-yet-imported new file, which is the conservative
  // reading.
  const stale = known.filter((name) => !documents.includes(name))
  return { drafts, record: stale.length > 0 ? drafts : null }
}

/** Apply a resolution to the index, returning a new one. */
export function withResolution(
  index: DraftIndex,
  articlePath: string,
  record: string[] | null
): DraftIndex {
  if (record === null) return index
  return { ...index, [articlePath]: record }
}

/** Store an explicit choice, keeping the folder's own document order. */
export function setDrafts(
  index: DraftIndex,
  articlePath: string,
  documents: string[],
  chosen: string[]
): DraftIndex {
  const wanted = new Set(chosen)
  return { ...index, [articlePath]: documents.filter((d) => wanted.has(d)) }
}
