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

/**
 * Trim sentence punctuation that Word glues onto a URL. This applies to stored
 * hyperlink targets too, not just bare text: authors routinely select the
 * trailing semicolon along with the address when they paste, and Word faithfully
 * preserves it inside the relationship, producing a target that 404s.
 */
function normalizeUrl(url: string): string {
  let out = url.trim().replace(/[.,;:]+$/, '')
  // Drop a closing paren only when nothing opened it, e.g. "(see https://x.com/a)".
  if (out.endsWith(')') && !out.includes('(')) out = out.slice(0, -1)
  return out
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
  /** A snapshot the source file already knew about, for import rather than recapture. */
  knownArchive?: string
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

  const add = (doc: string, link: ExtractedLink, knownArchive?: string): void => {
    const entry = merged.get(link.url)
    if (entry) {
      if (!entry.foundIn.includes(doc)) entry.foundIn.push(doc)
      if (!entry.link.anchorText && link.anchorText) entry.link.anchorText = link.anchorText
      if (!entry.knownArchive && knownArchive) entry.knownArchive = knownArchive
      return
    }
    merged.set(link.url, { link, foundIn: [doc], knownArchive })
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
