/**
 * Link extraction from HTML and ODT — the formats Google Docs exports.
 *
 * Reading a Google Doc live would mean OAuth, a Google account, and network
 * calls on the journalist's behalf, which would quietly undo the promise that
 * Backfile is offline and account-free. Exporting the doc instead costs one
 * menu click (File → Download) and keeps that promise intact.
 *
 * Google's HTML export wraps every link in a redirector
 * (google.com/url?q=<real url>), so the real destination has to be unwrapped or
 * every archived citation would point at Google instead of the source.
 */

import { promises as fs } from 'node:fs'
import { unzipSync } from 'fflate'
import { ExtractedLink } from './extractLinks'
import { normalizeUrl } from '../../shared/links'

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

/**
 * Unwrap Google's link redirector. Also handles the Office/Outlook "safelinks"
 * wrapper, which shows up when a draft has been round-tripped through email.
 */
export function unwrapRedirect(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (host.endsWith('google.com') && parsed.pathname === '/url') {
      const real = parsed.searchParams.get('q') ?? parsed.searchParams.get('url')
      if (real) return unwrapRedirect(real)
    }
    if (host.endsWith('safelinks.protection.outlook.com')) {
      const real = parsed.searchParams.get('url')
      if (real) return unwrapRedirect(real)
    }
  } catch {
    // Not a parseable URL; hand it back untouched.
  }
  return url
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}

export function extractLinksFromHtml(html: string): ExtractedLink[] {
  const byUrl = new Map<string, ExtractedLink>()

  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1]
    if (!href) continue
    const url = normalizeUrl(unwrapRedirect(decodeEntities(href)))
    if (!/^https?:\/\//i.test(url)) continue
    const anchorText = stripTags(m[2])
    const existing = byUrl.get(url)
    if (existing) {
      if (!existing.anchorText && anchorText) existing.anchorText = anchorText
    } else {
      byUrl.set(url, { url, anchorText })
    }
  }

  return [...byUrl.values()]
}

/**
 * ODT is a zip like .docx, but links are inline attributes on the text run
 * rather than split across a separate relationships part.
 */
export async function extractLinksFromOdt(filePath: string): Promise<ExtractedLink[]> {
  const buf = await fs.readFile(filePath)
  const zip = unzipSync(new Uint8Array(buf))
  const content = zip['content.xml']
  if (!content) return []
  const xml = new TextDecoder('utf-8').decode(content)

  const byUrl = new Map<string, ExtractedLink>()
  const re = /<text:a\b([^>]*)>([\s\S]*?)<\/text:a>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const href = /xlink:href\s*=\s*"([^"]+)"/.exec(m[1])?.[1]
    if (!href) continue
    const url = normalizeUrl(unwrapRedirect(decodeEntities(href)))
    if (!/^https?:\/\//i.test(url)) continue
    const anchorText = stripTags(m[2])
    const existing = byUrl.get(url)
    if (existing) {
      if (!existing.anchorText && anchorText) existing.anchorText = anchorText
    } else {
      byUrl.set(url, { url, anchorText })
    }
  }
  return [...byUrl.values()]
}

export async function extractLinksFromHtmlFile(filePath: string): Promise<ExtractedLink[]> {
  return extractLinksFromHtml(await fs.readFile(filePath, 'utf8'))
}

export function isHtmlSource(name: string): boolean {
  return /\.(html?|xhtml)$/i.test(name) && !name.startsWith('.') && !name.startsWith('~$')
}

export function isOdtSource(name: string): boolean {
  return /\.odt$/i.test(name) && !name.startsWith('.') && !name.startsWith('~$')
}
