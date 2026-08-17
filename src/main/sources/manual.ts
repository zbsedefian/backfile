/**
 * Creating collections and adding sources by hand.
 *
 * Not every link arrives inside a draft. A journalist finds something worth
 * keeping before the piece exists, or captures a snapshot in a browser and
 * needs somewhere to put it. Without this, the only way into Backfile was to
 * already have written the article — which is backwards.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { SourceLink, isPermanentCitation } from '../../shared/types'
import { normalizeUrl, parsePastedLink } from '../../shared/links'
import { readSources, writeSources, SOURCES_FILENAME } from './csv'
import { withLock } from './lock'

function sanitizeFolderName(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  if (!cleaned) throw new Error('a collection needs a name')
  return cleaned
}

/** Create an empty collection folder with a sources.csv ready to fill. */
export async function createCollection(root: string, name: string): Promise<string> {
  const folder = path.join(root, sanitizeFolderName(name))
  try {
    // Fails rather than silently adopting an existing folder, which could
    // quietly attach this collection to unrelated files.
    await fs.mkdir(folder, { recursive: false })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`"${path.basename(folder)}" already exists here`)
    }
    throw err
  }
  await writeSources(folder, [])
  return folder
}

export interface NewSource {
  url: string
  archiveIs?: string
  wayback?: string
  notes?: string
}

/**
 * Add one source to a collection, or merge into the existing row if the URL is
 * already recorded. Merging never overwrites a snapshot that is already there.
 */
export async function addSource(
  articlePath: string,
  input: NewSource
): Promise<{ links: SourceLink[]; merged: boolean }> {
  return withLock(articlePath, () => addSourceLocked(articlePath, input))
}

async function addSourceLocked(
  articlePath: string,
  input: NewSource
): Promise<{ links: SourceLink[]; merged: boolean }> {
  const parsed = parsePastedLink(input.url)

  // Explicit fields win over anything inferred from the pasted URL.
  const archiveIs = input.archiveIs?.trim() || parsed.archiveIs
  const wayback = input.wayback?.trim() || parsed.wayback
  let url = parsed.url ? normalizeUrl(parsed.url) : ''

  if (!url) {
    // Only a snapshot was supplied. Record it under the snapshot's own address
    // so nothing is lost; the journalist can correct the source URL later.
    url = archiveIs || wayback
  }
  if (!url) throw new Error('a source needs a URL')

  const links = await readSources(articlePath)
  const existing = links.find((l) => l.url === url)

  if (existing) {
    if (archiveIs && !existing.archiveIs) existing.archiveIs = archiveIs
    if (wayback && !existing.wayback) existing.wayback = wayback
    if (input.notes) {
      existing.notes = existing.notes ? `${existing.notes}; ${input.notes}` : input.notes
    }
    await writeSources(articlePath, links)
    return { links, merged: true }
  }

  const permanent = isPermanentCitation(url)
  links.push({
    url,
    anchorText: '',
    title: '',
    foundIn: [],
    articleSource: [],
    archiveIs,
    wayback,
    localPath: '',
    videoPath: '',
    screenshotPath: '',
    capturedAt: archiveIs || wayback ? new Date().toISOString().slice(0, 19).replace('T', ' ') : '',
    lastCheckedAt: '',
    linkStatus: '',
    verifiedBy: '',
    notes: input.notes ?? (parsed.snapshotOnly && !parsed.url ? 'source URL not yet recorded' : ''),
    excluded: permanent,
    excludedReason: permanent ? 'permanent citation (DOI/repository) — no snapshot needed' : ''
  })

  links.sort((a, b) => a.url.localeCompare(b.url))
  await writeSources(articlePath, links)
  return { links, merged: false }
}

/** Remove several sources at once, in a single write. */
export async function removeSources(
  articlePath: string,
  urls: string[]
): Promise<SourceLink[]> {
  const doomed = new Set(urls)
  return withLock(articlePath, async () => {
    const links = (await readSources(articlePath)).filter((l) => !doomed.has(l.url))
    await writeSources(articlePath, links)
    return links
  })
}

export async function removeSource(articlePath: string, url: string): Promise<SourceLink[]> {
  return withLock(articlePath, async () => {
    const links = (await readSources(articlePath)).filter((l) => l.url !== url)
    await writeSources(articlePath, links)
    return links
  })
}

/** Update the source URL of a row, e.g. after looking up what a snapshot was of. */
export async function updateSourceUrl(
  articlePath: string,
  oldUrl: string,
  newUrl: string
): Promise<SourceLink[]> {
  return withLock(articlePath, async () => {
    const links = await readSources(articlePath)
    const link = links.find((l) => l.url === oldUrl)
    if (!link) return links
    link.url = newUrl.trim()
    if (link.notes === 'source URL not yet recorded') link.notes = ''
    links.sort((a, b) => a.url.localeCompare(b.url))
    await writeSources(articlePath, links)
    return links
  })
}

export { SOURCES_FILENAME }
export { parsePastedLink } from '../../shared/links'
