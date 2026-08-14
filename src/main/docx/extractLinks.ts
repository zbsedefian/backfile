/**
 * Pull every external link out of a .docx.
 *
 * A .docx is a zip of XML. Hyperlinks are stored in two halves: the visible run
 * carries an r:id, and the matching relationships file holds the actual target.
 * Both halves have to be read, and they have to be read for the body, the
 * footnotes and the endnotes separately — in practice most of a journalist's
 * citations live in the notes, so a body-only reader misses the majority.
 */

import { promises as fs } from 'node:fs'
import { unzipSync } from 'fflate'
import { normalizeUrl, parsePastedLink } from '../../shared/links'
import { extractLinksFromText, isTextSource } from './extractFromText'
import {
  extractLinksFromHtmlFile,
  extractLinksFromOdt,
  isHtmlSource,
  isOdtSource
} from './extractFromHtml'

export interface ExtractedLink {
  url: string
  anchorText: string
}

/** The three part/relationship pairs that can contain citations. */
const PARTS = [
  { xml: 'word/document.xml', rels: 'word/_rels/document.xml.rels' },
  { xml: 'word/footnotes.xml', rels: 'word/_rels/footnotes.xml.rels' },
  { xml: 'word/endnotes.xml', rels: 'word/_rels/endnotes.xml.rels' }
]

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    // Ampersand last, so "&amp;lt;" does not collapse into a tag.
    .replace(/&amp;/g, '&')
}

/** Map rId -> external target from a .rels part. */
function parseRels(xml: string): Map<string, string> {
  const map = new Map<string, string>()
  const re = /<Relationship\b[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0]
    // Only external targets are real links; internal ones point at parts of the doc.
    if (!/TargetMode\s*=\s*"External"/.test(tag)) continue
    const id = /\bId\s*=\s*"([^"]+)"/.exec(tag)?.[1]
    const target = /\bTarget\s*=\s*"([^"]+)"/.exec(tag)?.[1]
    if (id && target) map.set(id, decodeEntities(target))
  }
  return map
}

/** Concatenate the <w:t> runs inside a fragment to recover its visible text. */
function visibleText(fragment: string): string {
  const parts: string[] = []
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(fragment)) !== null) parts.push(decodeEntities(m[1]))
  return parts.join('').replace(/\s+/g, ' ').trim()
}

/** Bare URLs that were typed as plain text and never turned into hyperlinks. */
function bareUrls(xml: string): string[] {
  const text = visibleText(xml)
  return text.match(/https?:\/\/[^\s<>"'\]]+/g) ?? []
}

export async function extractLinksFromDocx(filePath: string): Promise<ExtractedLink[]> {
  const buf = await fs.readFile(filePath)
  const zip = unzipSync(new Uint8Array(buf))
  const decoder = new TextDecoder('utf-8')
  const read = (name: string): string | null =>
    zip[name] ? decoder.decode(zip[name]) : null

  // Keyed by URL so the same source cited in body and footnote collapses to one
  // entry, preferring whichever occurrence actually carried anchor text.
  const byUrl = new Map<string, ExtractedLink>()
  const add = (rawUrl: string, anchorText: string): void => {
    const url = normalizeUrl(rawUrl)
    if (!/^https?:\/\//i.test(url)) return
    const existing = byUrl.get(url)
    if (existing) {
      if (!existing.anchorText && anchorText) existing.anchorText = anchorText
      return
    }
    byUrl.set(url, { url, anchorText })
  }

  for (const part of PARTS) {
    const xml = read(part.xml)
    if (!xml) continue
    const rels = parseRels(read(part.rels) ?? '')

    const re = /<w:hyperlink\b([^>]*)>([\s\S]*?)<\/w:hyperlink>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(xml)) !== null) {
      const id = /r:id\s*=\s*"([^"]+)"/.exec(m[1])?.[1]
      if (!id) continue
      const target = rels.get(id)
      if (target) add(target, visibleText(m[2]))
    }

    for (const url of bareUrls(xml)) add(url, '')
  }

  return [...byUrl.values()]
}

export interface MergedLink {
  link: ExtractedLink
  foundIn: string[]
  /** Snapshots the document already contained, for import rather than recapture. */
  knownArchiveIs?: string
  knownWayback?: string
}

/**
 * Merge the links of every source file in a folder, tracking which files each
 * came from. Handles .docx drafts and plain-text link lists alike.
 */
export async function extractLinksFromDocuments(
  articlePath: string,
  documents: string[]
): Promise<Map<string, MergedLink>> {
  const merged = new Map<string, MergedLink>()

  /** Sort a snapshot address into the column it belongs in. */
  const classify = (snapshot: string): { archiveIs?: string; wayback?: string } =>
    /web\.archive\.org/i.test(snapshot) ? { wayback: snapshot } : { archiveIs: snapshot }

  const add = (doc: string, link: ExtractedLink, knownArchive?: string): void => {
    /*
     * A draft frequently cites a snapshot directly — the journalist archived
     * the page months ago and pasted the archive link into the piece. Treating
     * that as an unarchived source put work back in the queue that was already
     * done, and showed a secured citation as a gap.
     *
     * A Wayback address carries its original inside it, so it is filed under
     * that original and merges with any plain citation of the same page. An
     * archive.is short link does not, so it stands as its own source — but it
     * is already permanent, which is what matters.
     */
    const parsed = parsePastedLink(link.url)
    let key = link.url
    let archiveIs: string | undefined
    let wayback: string | undefined

    if (parsed.wayback && parsed.url) {
      key = parsed.url
      wayback = parsed.wayback
    } else if (parsed.snapshotOnly && parsed.archiveIs) {
      key = parsed.archiveIs
      archiveIs = parsed.archiveIs
    }

    if (knownArchive) {
      const sorted = classify(knownArchive)
      archiveIs = archiveIs ?? sorted.archiveIs
      wayback = wayback ?? sorted.wayback
    }

    const entry = merged.get(key)
    if (entry) {
      if (!entry.foundIn.includes(doc)) entry.foundIn.push(doc)
      if (!entry.link.anchorText && link.anchorText) entry.link.anchorText = link.anchorText
      // Never overwrite a snapshot already gathered from an earlier mention.
      if (!entry.knownArchiveIs && archiveIs) entry.knownArchiveIs = archiveIs
      if (!entry.knownWayback && wayback) entry.knownWayback = wayback
      return
    }

    merged.set(key, {
      link: { url: key, anchorText: link.anchorText },
      foundIn: [doc],
      knownArchiveIs: archiveIs,
      knownWayback: wayback
    })
  }

  for (const doc of documents) {
    const full = `${articlePath}/${doc}`
    try {
      if (isTextSource(doc)) {
        const text = await fs.readFile(full, 'utf8')
        for (const { url, knownArchive } of extractLinksFromText(text)) {
          add(doc, { url, anchorText: '' }, knownArchive)
        }
      } else if (isHtmlSource(doc)) {
        for (const link of await extractLinksFromHtmlFile(full)) add(doc, link)
      } else if (isOdtSource(doc)) {
        for (const link of await extractLinksFromOdt(full)) add(doc, link)
      } else {
        for (const link of await extractLinksFromDocx(full)) add(doc, link)
      }
    } catch {
      // A corrupt, locked or unreadable file should not sink the whole scan.
      continue
    }
  }
  return merged
}
