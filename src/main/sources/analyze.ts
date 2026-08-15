/**
 * Reconcile the links found in an article's drafts with what sources.csv
 * already records.
 *
 * The governing rule is that analysis never destroys work. A snapshot captured
 * by hand months ago outlives the sentence that cited it, so a link that has
 * disappeared from every draft is kept, not deleted — an editor's cut is not a
 * reason to throw away evidence.
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { SourceLink, isPermanentCitation } from '../../shared/types'
import { extractLinksFromDocuments } from '../docx/extractLinks'
import { extractTitleFromMhtml, TITLE_SCAN_BYTES } from '../capture/mhtmlTitle'
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

  for (const [url, { link, foundIn, knownArchiveIs, knownWayback }] of found) {
    const current = byUrl.get(url)
    if (current) {
      const before = JSON.stringify([
        current.foundIn,
        current.anchorText,
        current.archiveIs,
        current.wayback
      ])
      current.foundIn = foundIn
      // Mirrors foundIn exactly today, but kept as its own field — see the
      // doc comment on SourceLink.articleSource for why.
      current.articleSource = foundIn
      if (!current.anchorText && link.anchorText) current.anchorText = link.anchorText
      // Adopt snapshots the document already carried, but never overwrite one.
      if (knownArchiveIs && !current.archiveIs) {
        current.archiveIs = knownArchiveIs
        imported++
      }
      if (knownWayback && !current.wayback) {
        current.wayback = knownWayback
        imported++
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
    if (knownArchiveIs) imported++
    if (knownWayback) imported++
    byUrl.set(url, {
      url,
      anchorText: link.anchorText,
      title: '',
      foundIn,
      articleSource: foundIn,
      archiveIs: knownArchiveIs ?? '',
      wayback: knownWayback ?? '',
      localPath: '',
      videoPath: '',
      screenshotPath: '',
      capturedAt:
        knownArchiveIs || knownWayback
          ? new Date().toISOString().slice(0, 19).replace('T', ' ')
          : '',
      notes: '',
      // Pre-excluding DOI and repository links keeps the work queue honest:
      // they are already permanent, and chasing snapshots for them is busywork.
      excluded: permanent,
      excludedReason: permanent ? EXCLUSION_REASON : ''
    })
    added++
  }

  // A source the drafts no longer cite keeps its row and its snapshots — an
  // editor's cut is not a reason to discard evidence — but found_in has to stop
  // naming a document that no longer mentions it. Otherwise unticking a
  // reference document leaves every link it dragged in still looking cited, and
  // the orphaned view, which is the only way to find those rows again, lists
  // none of them.
  for (const link of byUrl.values()) {
    if (!found.has(link.url)) {
      link.foundIn = []
      link.articleSource = []
    }
  }

  const orphaned = [...byUrl.values()].filter((l) => !found.has(l.url)).length

  const links = [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url))
  await backfillTitles(articlePath, links)
  await writeSources(articlePath, links)
  return { links, added, updated, orphaned, imported }
}

/** Forget one recorded capture so it can be redone. */
export async function clearCapture(
  articlePath: string,
  url: string,
  field: 'archiveIs' | 'wayback' | 'localPath' | 'videoPath'
): Promise<SourceLink[]> {
  return withLock(articlePath, async () => {
    const links = await readSources(articlePath)
    const link = links.find((l) => l.url === url)
    if (!link) return links
    link[field] = ''
    await writeSources(articlePath, links)
    return links
  })
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
  value: string,
  title?: string,
  screenshotPath?: string
): Promise<SourceLink[]> {
  return withLock(articlePath, async () => {
    const links = await readSources(articlePath)
    const link = links.find((l) => l.url === url)
    if (!link) return links
    link[field] = value
    // A re-capture refreshes the headline; a service that cannot read one
    // leaves whatever is already recorded alone.
    const clean = tidyTitle(title ?? '')
    if (clean) link.title = clean
    if (screenshotPath) link.screenshotPath = screenshotPath
    link.capturedAt = new Date().toISOString().slice(0, 19).replace('T', ' ')
    await writeSources(articlePath, links)
    return links
  })
}

/** Reject the placeholder titles a bot-check or error page hands back. */
function tidyTitle(title: string): string {
  return extractTitleFromMhtml(`<title>${title}</title>`)
}

/**
 * Fill in headlines for captures taken before Backfile recorded them.
 *
 * Reads only the local files already on disk — no request goes out — and only
 * for rows that have a capture but no title yet, so this settles after one pass
 * instead of re-reading every capture on every analysis.
 */
export async function backfillTitles(
  articlePath: string,
  links: SourceLink[]
): Promise<number> {
  let filled = 0
  for (const link of links) {
    if (link.title || !link.localPath) continue
    try {
      const handle = await fsp.open(path.join(articlePath, link.localPath), 'r')
      try {
        const buffer = Buffer.alloc(TITLE_SCAN_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, TITLE_SCAN_BYTES, 0)
        const title = extractTitleFromMhtml(buffer.subarray(0, bytesRead).toString('latin1'))
        if (title) {
          link.title = title
          filled++
        }
      } finally {
        await handle.close()
      }
    } catch {
      // A capture that has been moved or deleted simply has no title to read.
    }
  }
  return filled
}
