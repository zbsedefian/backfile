/**
 * Produce a copy of a .docx with every cited link repointed at its archive
 * snapshot.
 *
 * This is the payoff for all the capturing: a version of the piece that can be
 * filed, published or handed to a fact-checker whose links will still resolve
 * after the originals rot. The original file is never modified — the rewritten
 * copy is written alongside it under a new name.
 *
 * Only the relationship targets are touched. The visible text is left exactly as
 * written, so the article still reads as "according to the Times" rather than
 * "according to archive.ph/aB3x9", while the underlying link is the durable one.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { SourceLink } from '../../shared/types'
import { normalizeUrl } from '../../shared/links'

/** Relationship parts that can carry external hyperlinks. */
const RELS_PARTS = [
  'word/_rels/document.xml.rels',
  'word/_rels/footnotes.xml.rels',
  'word/_rels/endnotes.xml.rels'
]

export interface RewriteResult {
  outputPath: string
  /** Relationship targets repointed at a snapshot. */
  rewritten: number
  /** External targets left alone because no snapshot exists yet. */
  untouched: number
}

export interface PlannedChange {
  url: string
  snapshot: string
  anchorText: string
  /** How many relationship entries point at this URL. */
  occurrences: number
  /** Whether the snapshot is archive.is or the less stable Wayback. */
  service: 'archive.is' | 'wayback'
}

export interface RewritePlan {
  documentName: string
  outputName: string
  changes: PlannedChange[]
  /** Cited URLs with no snapshot, which will be published as-is. */
  unarchived: string[]
  /** True when publishing would replace a file already sitting there. */
  overwrites: boolean
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function decodeAttr(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * The same normaliser extraction uses. If these two ever diverge the rewriter
 * quietly stops matching links it should have repointed, which is the sort of
 * failure that only shows up in a published article.
 */
const normalize = normalizeUrl

/**
 * Choose the snapshot to publish. archive.is is preferred: it is a fixed
 * rendering of the page, whereas a Wayback URL can resolve to a different
 * capture over time. A local file path is never substituted — it would be a
 * dead link on anyone else's machine.
 */
export function preferredSnapshot(link: SourceLink): string | null {
  return link.archiveIs || link.wayback || null
}

/**
 * The suffix marking a file Backfile produced.
 *
 * Exported because the scanner has to recognise these and leave them alone: a
 * published copy is full of archive links this app just wrote, so reading it
 * back in files every snapshot as though it were a freshly discovered source.
 */
export const PUBLISHED_SUFFIX = ' (archived links).docx'

/** True for a file Backfile generated, rather than something the journalist wrote. */
export function isPublishedCopy(name: string): boolean {
  return name.toLowerCase().endsWith(PUBLISHED_SUFFIX.toLowerCase())
}

function outputNameFor(documentName: string): string {
  return `${documentName.replace(/\.docx$/i, '')}${PUBLISHED_SUFFIX}`
}

/** Every external target in the document, with how often each appears. */
async function targetCounts(articlePath: string, documentName: string): Promise<Map<string, number>> {
  const buf = await fs.readFile(path.join(articlePath, documentName))
  const zip = unzipSync(new Uint8Array(buf))
  const decoder = new TextDecoder('utf-8')
  const counts = new Map<string, number>()

  for (const part of RELS_PARTS) {
    const raw = zip[part]
    if (!raw) continue
    for (const tag of decoder.decode(raw).match(/<Relationship\b[^>]*>/g) ?? []) {
      if (!/TargetMode\s*=\s*"External"/.test(tag)) continue
      const target = /\bTarget\s*=\s*"([^"]*)"/.exec(tag)?.[1]
      if (!target) continue
      const url = normalize(decodeAttr(target))
      if (!/^https?:\/\//i.test(url)) continue
      counts.set(url, (counts.get(url) ?? 0) + 1)
    }
  }
  return counts
}

/**
 * Work out exactly what publishing would change, without writing anything.
 *
 * Rewriting someone's citations is not an action to discover after the fact,
 * so this exists to be shown first.
 */
export async function planDocxRewrite(
  articlePath: string,
  documentName: string,
  links: SourceLink[]
): Promise<RewritePlan> {
  const counts = await targetCounts(articlePath, documentName)
  const byUrl = new Map(links.map((l) => [normalize(l.url), l]))

  const changes: PlannedChange[] = []
  const unarchived: string[] = []

  for (const [url, occurrences] of counts) {
    const link = byUrl.get(url)
    if (!link || link.excluded) continue
    const snapshot = preferredSnapshot(link)
    if (!snapshot) {
      unarchived.push(url)
      continue
    }
    changes.push({
      url,
      snapshot,
      anchorText: link.anchorText,
      occurrences,
      service: /web\.archive\.org/i.test(snapshot) ? 'wayback' : 'archive.is'
    })
  }

  changes.sort((a, b) => a.url.localeCompare(b.url))
  unarchived.sort()

  const outputName = outputNameFor(documentName)
  const overwrites = await fs
    .access(path.join(articlePath, outputName))
    .then(() => true)
    .catch(() => false)

  return { documentName, outputName, changes, unarchived, overwrites }
}

export async function rewriteDocxLinks(
  articlePath: string,
  documentName: string,
  links: SourceLink[],
  outputName?: string
): Promise<RewriteResult> {
  const source = path.join(articlePath, documentName)
  const buf = await fs.readFile(source)
  const zip = unzipSync(new Uint8Array(buf))

  const replacements = new Map<string, string>()
  for (const link of links) {
    if (link.excluded) continue
    const snapshot = preferredSnapshot(link)
    if (snapshot) replacements.set(normalize(link.url), snapshot)
  }

  let rewritten = 0
  let untouched = 0
  const decoder = new TextDecoder('utf-8')
  const encoder = new TextEncoder()

  for (const part of RELS_PARTS) {
    const raw = zip[part]
    if (!raw) continue

    const updated = decoder.decode(raw).replace(/<Relationship\b[^>]*>/g, (tag) => {
      if (!/TargetMode\s*=\s*"External"/.test(tag)) return tag
      const target = /\bTarget\s*=\s*"([^"]*)"/.exec(tag)?.[1]
      if (!target) return tag

      const snapshot = replacements.get(normalize(decodeAttr(target)))
      if (!snapshot) {
        if (/^https?:\/\//i.test(decodeAttr(target))) untouched++
        return tag
      }
      rewritten++
      return tag.replace(/(\bTarget\s*=\s*")[^"]*(")/, `$1${escapeAttr(snapshot)}$2`)
    })

    zip[part] = encoder.encode(updated)
  }

  const outName = outputName ?? outputNameFor(documentName)
  const outputPath = path.join(articlePath, outName)
  // Word rejects a .docx whose parts are deflated inconsistently; level 6 is
  // what Word itself writes and is what round-trips reliably.
  await fs.writeFile(outputPath, Buffer.from(zipSync(zip, { level: 6 })))

  return { outputPath: outName, rewritten, untouched }
}
