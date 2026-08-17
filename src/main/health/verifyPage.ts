/**
 * Judging what actually came up in the pane, for human-assisted verification.
 *
 * The automated checker in checkLinks.ts cannot get past a bot wall — that is
 * the whole reason `unverified` exists as a status. The way through is the one
 * archive.is captures already use: put a real browser in front of the
 * journalist and let them clear the check themselves. But a human clicking
 * "open" is not evidence of anything, so what makes this verification rather
 * than a dismissal is that Backfile watches what the tab settles on and judges
 * that, not the click.
 *
 * The rules below are deliberately conservative about saying "verified". While
 * a challenge page is up, or while the tab is off on some other site, the
 * verdict is "keep waiting" — the flag stays exactly as it was. Only a page
 * that settles on the source's own site, with a title that is not a wall,
 * produces a verdict at all.
 */

import { LinkStatus } from '../../shared/types'
import { isPlaceholderTitle } from '../capture/mhtmlTitle'

/**
 * A redirect that lands on nothing but the domain — no path, no query — is
 * the shape a removed or reorganised article takes almost every time: the
 * publisher's server still answers, it just has nothing left to say about
 * this specific page. A redirect that lands somewhere more specific (a new
 * slug, an https upgrade, a www-stripped host) is still the same article and
 * counts as resolving fine.
 *
 * Lives here rather than in checkLinks.ts because both the plain HTTP check
 * and the judging below need it, and the other direction would be a cycle.
 */
export function isBareHomepage(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.pathname === '' || u.pathname === '/') && u.search === ''
  } catch {
    return false
  }
}

export interface SettledInput {
  /** The source's original URL, as recorded in sources.csv. */
  originalUrl: string
  /** Where the tab actually ended up. */
  finalUrl: string
  /** The page's own title, as the tab reports it. */
  title: string
  /** Status of the last main-frame navigation, when one was reported. */
  httpStatus: number | null
}

export type VerifyVerdict =
  /** Nothing to record yet; the human has not arrived at the real page. */
  | { done: false; waitingOn: 'blank' | 'challenge' | 'elsewhere' }
  /** Observed clearly enough to write down. */
  | { done: true; status: LinkStatus }

/**
 * Whether two URLs are the same site, ignoring a leading "www.".
 *
 * A challenge wall serves from the article's own host, so staying on-site is
 * what separates "the reader worked through the interstitial" from "the reader
 * gave up and went to Google" — and only the first says anything about whether
 * this source resolves.
 */
export function sameSite(a: string, b: string): boolean {
  try {
    const strip = (u: string): string => new URL(u).hostname.toLowerCase().replace(/^www\./, '')
    return strip(a) === strip(b)
  } catch {
    return false
  }
}

export function classifySettledPage(input: SettledInput): VerifyVerdict {
  const { originalUrl, finalUrl, title, httpStatus } = input

  // A tab that has not gone anywhere yet — the blank the session opens with.
  if (!finalUrl || finalUrl === 'about:blank') return { done: false, waitingOn: 'blank' }

  // Off the source's own site: whatever this page says, it is not evidence
  // about the source. Includes an SSO or consent host a wall bounces through
  // on its way back, which is exactly a case worth waiting out rather than
  // recording.
  if (!sameSite(originalUrl, finalUrl)) return { done: false, waitingOn: 'elsewhere' }

  // Checked before the status codes below on purpose: Cloudflare's interstitial
  // is commonly served as a 403 or 503, and reading that as a dead source is
  // precisely the false negative this whole feature exists to stop.
  if (isPlaceholderTitle(title)) return { done: false, waitingOn: 'challenge' }

  if (httpStatus === 404 || httpStatus === 410) return { done: true, status: 'notfound' }
  if (httpStatus !== null && httpStatus >= 500) return { done: true, status: 'servererror' }

  // Landed on the homepage instead of the article — the same shape of rot the
  // automated check looks for, but now confirmed by a real browser rather than
  // inferred from a redirect chain.
  if (isBareHomepage(finalUrl) && !isBareHomepage(originalUrl)) {
    return { done: true, status: 'redirected' }
  }

  return { done: true, status: 'ok' }
}
