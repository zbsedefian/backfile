/**
 * Reconcile the links found in an article's drafts with what sources.csv
 * already records.
 *
 * The governing rule is that analysis never destroys work. A snapshot captured
 * by hand months ago outlives the sentence that cited it, so a link that has
 * disappeared from every draft is kept, not deleted — an editor's cut is not a
 * reason to throw away evidence.
 */

import { SourceLink, isPermanentCitation } from '../../shared/types'
import { extractLinksFromDocuments } from '../docx/extractLinks'
import { readSources, writeSources } from './csv'
import { withLock } from './lock'

export interface AnalyzeResult {
  links: SourceLink[]
  added: number
  updated: number
  /** Recorded links no longer present in any draft. */
  orphaned: number
  /** Snapshots adopted from a link list rather than captured here. */
  imported: number
}

const EXCLUSION_REASON = 'permanent citation (DOI/repository) — no snapshot needed'

export async function analyzeArticle(
  articlePath: string,
  documents: string[]
): Promise<AnalyzeResult> {
  const existing = await readSources(articlePath)
  const byUrl = new Map(existing.map((l) => [l.url, { ...l }]))
  const found = await extractLinksFromDocuments(articlePath, documents)

  let added = 0
  let updated = 0
  let imported = 0

  /** Sort a known snapshot into the right column. */
  const fieldForSnapshot = (snapshot: string): 'archiveIs' | 'wayback' =>
    /web\.archive\.org/i.test(snapshot) ? 'wayback' : 'archiveIs'

  for (const [url, { link, foundIn, knownArchive }] of found) {
    const current = byUrl.get(url)
    if (current) {
      const before = JSON.stringify([current.foundIn, current.anchorText, current.archiveIs, current.wayback])
      current.foundIn = foundIn
      if (!current.anchorText && link.anchorText) current.anchorText = link.anchorText
      // Adopt a snapshot the link list already recorded, but never overwrite one.
      if (knownArchive) {
        const field = fieldForSnapshot(knownArchive)
        if (!current[field]) {
          current[field] = knownArchive
          imported++
        }
      }
      if (
        JSON.stringify([current.foundIn, current.anchorText, current.archiveIs, current.wayback]) !==
        before
      ) {
        updated++
      }
      continue
    }
    const permanent = isPermanentCitation(url)
    const snapshotField = knownArchive ? fieldForSnapshot(knownArchive) : null
    if (knownArchive) imported++
    byUrl.set(url, {
      url,
      anchorText: link.anchorText,
      foundIn,
      archiveIs: snapshotField === 'archiveIs' ? knownArchive! : '',
      wayback: snapshotField === 'wayback' ? knownArchive! : '',
      localPath: '',
      videoPath: '',
      capturedAt: '',
      notes: '',
      // Pre-excluding DOI and repository links keeps the work queue honest:
      // they are already permanent, and chasing snapshots for them is busywork.
      excluded: permanent,
      excludedReason: permanent ? EXCLUSION_REASON : ''
    })
    added++
  }

  const orphaned = [...byUrl.values()].filter((l) => !found.has(l.url)).length

  const links = [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url))
  await writeSources(articlePath, links)
  return { links, added, updated, orphaned, imported }
}

/**
 * Record a capture result against a single link and persist it.
 *
 * Locked, because local downloads run several at a time and this is a
 * read-modify-write over the whole file: without serialisation two captures
 * finishing together would each read the same rows and the later write would
 * quietly drop the earlier one's snapshot.
 */
export async function recordCapture(
  articlePath: string,
  url: string,
  field: 'archiveIs' | 'wayback' | 'localPath' | 'videoPath',
  value: string
): Promise<SourceLink[]> {
  return withLock(articlePath, async () => {
    const links = await readSources(articlePath)
    const link = links.find((l) => l.url === url)
    if (!link) return links
    link[field] = value
    link.capturedAt = new Date().toISOString().slice(0, 19).replace('T', ' ')
    await writeSources(articlePath, links)
    return links
  })
}
