/**
 * archive.is / archive.today adapter — human-assisted by necessity.
 *
 * archive.is answers scripted requests with an immediate HTTP 429, for reads as
 * well as writes. That is bot protection, not rate limiting, so no amount of
 * backoff or politeness will ever make an automated capture work. The honest
 * design is to put a real browser in front of the journalist, let them clear the
 * CAPTCHA themselves, and then do the tedious part for them.
 *
 * Crucially the CAPTCHA is per-session, not per-URL: clear it once and the
 * cookie carries the rest of a batch. That is why a run of fifty sources
 * realistically costs one CAPTCHA, and why this reuses a single pane tab
 * instead of opening something new for every source.
 */

import { CaptureAdapter, CaptureContext, fail, ok } from './types'
import { CaptureResult } from '../../shared/types'
import { browserPane } from '../browser/BrowserPane'

/** archive.is rotates between these mirrors; a capture may finish on any of them. */
const MIRROR = String.raw`archive\.(?:ph|is|today|li|vn|md|fo)`

/**
 * A finished snapshot looks like https://archive.ph/AbCd1 — a single short
 * alphanumeric segment. These path segments look identical but are not
 * snapshots, and matching them would record a link that goes nowhere useful.
 */
const RESERVED = new Set([
  'submit',
  'newest',
  'oldest',
  'wip',
  'search',
  'download',
  'about',
  'faq',
  'terms',
  'offshore'
])

/**
 * How long a capture may run before the pane is flagged as needing attention.
 * archive.is shows an interstitial while it works, so this has to be generous
 * enough not to cry CAPTCHA at a page that is merely slow.
 */
const QUIET_TIMEOUT_MS = 25_000

/**
 * The ceiling on a single capture. A CAPTCHA can legitimately keep one waiting
 * for minutes, so this is generous — but it exists so that nothing, including a
 * page that never finishes loading, can wedge a run with no way out.
 */
const HARD_TIMEOUT_MS = 4 * 60_000

export function snapshotUrlFrom(candidate: string): string | null {
  const re = new RegExp(`^https?://${MIRROR}/([A-Za-z0-9]{4,12})/?$`)
  const m = re.exec(candidate.trim())
  if (!m) return null
  if (RESERVED.has(m[1].toLowerCase())) return null
  return `https://archive.ph/${m[1]}`
}

/** The page that starts a capture, with the target URL pre-filled. */
export function submitUrlFor(url: string): string {
  return `https://archive.ph/?run=1&url=${encodeURIComponent(url)}`
}

/**
 * A capture session bound to one tab of the embedded browser pane.
 *
 * One tab, one cleared CAPTCHA, many captures — and all of it inside the app
 * window, so nothing ever jumps in front of what the journalist is doing.
 */
export class ArchiveIsSession {
  private tabId: string | null = null
  private pending: ((result: CaptureResult) => void) | null = null
  private currentUrl = ''
  private cancelled = false
  private unlisten: (() => void) | null = null

  constructor(private readonly onNeedsHuman?: (url: string) => void) {}

  /** Open (or reuse) the capture tab and start watching it for snapshots. */
  prepare(): string {
    if (this.tabId) return this.tabId

    this.tabId = browserPane.open('about:blank', { activate: true })

    const listener = (url: string, tabId: string): void => {
      if (tabId !== this.tabId) return
      const snapshot = snapshotUrlFrom(url)
      if (snapshot) this.settle(ok('archiveIs', this.currentUrl, snapshot))
    }
    browserPane.navigationListeners.add(listener)
    this.unlisten = () => browserPane.navigationListeners.delete(listener)

    return this.tabId
  }

  private settle(result: CaptureResult): void {
    const resolve = this.pending
    this.pending = null
    if (resolve) resolve(result)
  }

  get isCancelled(): boolean {
    return this.cancelled
  }

  async capture(url: string): Promise<CaptureResult> {
    if (this.cancelled) return fail('archiveIs', url, 'cancelled')

    // The tab can disappear underneath a run — the journalist closes it, or a
    // previous batch tore it down. Navigating a tab that no longer exists is a
    // silent no-op, which used to leave this promise pending forever and hang
    // the whole batch with no way out. Rebuild it instead.
    if (!browserPane.hasTab(this.tabId)) {
      this.unlisten?.()
      this.unlisten = null
      this.tabId = null
    }

    const tabId = this.prepare()
    this.currentUrl = url

    return new Promise<CaptureResult>((resolve) => {
      const done = (result: CaptureResult): void => {
        clearTimeout(nudge)
        clearTimeout(deadline)
        clearInterval(watchdog)
        resolve(result)
      }

      // If it stalls, a CAPTCHA is probably waiting.
      const nudge = setTimeout(() => {
        if (this.pending !== done) return
        browserPane.activate(tabId)
        this.onNeedsHuman?.(url)
      }, QUIET_TIMEOUT_MS)

      // If the tab is closed mid-capture, stop waiting on it immediately rather
      // than sitting on a dead promise until the hard deadline.
      const watchdog = setInterval(() => {
        if (this.pending !== done) return
        if (!browserPane.hasTab(tabId)) {
          this.pending = null
          done(fail('archiveIs', url, 'capture tab was closed'))
        }
      }, 1_000)

      // A last-resort ceiling. Nothing here may hang a batch indefinitely.
      const deadline = setTimeout(() => {
        if (this.pending !== done) return
        this.pending = null
        done(fail('archiveIs', url, 'timed out waiting for a snapshot'))
      }, HARD_TIMEOUT_MS)

      this.pending = done
      browserPane.navigate(tabId, submitUrlFor(url))
    })
  }

  /** Abandon the current capture but keep the session alive for the next one. */
  skip(): void {
    this.settle(fail('archiveIs', this.currentUrl, 'skipped'))
  }

  cancel(): void {
    this.cancelled = true
    this.settle(fail('archiveIs', this.currentUrl, 'cancelled'))
  }

  close(): void {
    this.unlisten?.()
    this.unlisten = null
    const tabId = this.tabId
    this.tabId = null
    if (!tabId) return
    // Leave the finished snapshot on screen just long enough to register, then
    // clear it away — the record is already written to sources.csv, so keeping
    // the tab around only accumulates clutter across a run.
    setTimeout(() => browserPane.close(tabId), 1_200)
  }
}

export const archiveIsAdapter: CaptureAdapter = {
  id: 'archiveIs',
  label: 'archive.is',
  requiresHuman: true,

  async capture(url: string, _ctx: CaptureContext): Promise<CaptureResult> {
    const session = new ArchiveIsSession()
    try {
      return await session.capture(url)
    } finally {
      session.close()
    }
  }
}
