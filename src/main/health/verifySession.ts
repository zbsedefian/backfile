/**
 * Human-assisted link verification, bound to one tab of the embedded pane.
 *
 * Same bargain as the archive.is capture session next door: when a site's bot
 * protection makes an automated answer impossible, put a real browser in front
 * of the journalist and let them clear the check themselves. The difference is
 * what counts as the result — archive.is watches for a snapshot URL, this
 * watches for the source's own page to actually come up, and writes down what
 * it sees rather than what it was asked to see.
 *
 * Nothing is recorded until the pane settles on something judgeable. A wall
 * that is never cleared, a tab closed halfway, a reader who wanders off to
 * another site: all of those end the session with the flag exactly as it was.
 */

import { LinkStatus } from '../../shared/types'
import { browserPane, SettledPage } from '../browser/BrowserPane'
import { classifySettledPage } from './verifyPage'
import { recordLinkCheck } from './checkLinks'

/**
 * The ceiling on one verification. Generous, because a human answering a
 * CAPTCHA legitimately takes minutes — but finite, so a forgotten tab cannot
 * leave the session waiting for the rest of the app's life.
 */
const HARD_TIMEOUT_MS = 5 * 60_000

/** How often to notice the journalist has closed the tab out from under this. */
const TAB_WATCH_MS = 1_000

export interface VerifyOutcome {
  /** What was actually observed, or null when nothing ever was. */
  status: LinkStatus | null
  /** Why it ended without a verdict, for the status bar to explain. */
  reason?: string
}

export class VerifySession {
  private finish: ((outcome: VerifyOutcome) => void) | null = null

  /** Give up on the current verification without recording anything. */
  cancel(): void {
    this.finish?.({ status: null, reason: 'cancelled' })
  }

  async run(articlePath: string, url: string): Promise<VerifyOutcome> {
    // Explicitly not automated: the whole point is that the page may need to be
    // clicked and typed into, so it gets the keyboard rather than having focus
    // held back in the app the way a batch capture does.
    browserPane.automated = false
    const tabId = browserPane.open(url, { activate: true })

    return new Promise<VerifyOutcome>((resolve) => {
      const done = (outcome: VerifyOutcome): void => {
        if (this.finish !== done) return
        this.finish = null
        clearTimeout(deadline)
        clearInterval(watchdog)
        browserPane.settleListeners.delete(listener)
        resolve(outcome)
      }
      this.finish = done

      const listener = (page: SettledPage): void => {
        if (page.tabId !== tabId) return
        const verdict = classifySettledPage({
          originalUrl: url,
          finalUrl: page.url,
          title: page.title,
          httpStatus: page.httpStatus
        })
        // Still behind a wall, still elsewhere, still blank: keep watching.
        // This is the branch that makes the feature honest — it is what stops
        // "the reader clicked" from being mistaken for "the page is fine".
        if (!verdict.done) return
        void recordLinkCheck(articlePath, url, verdict.status)
          .then(() => done({ status: verdict.status }))
          .catch(() => done({ status: null, reason: 'the result could not be saved' }))
      }
      browserPane.settleListeners.add(listener)

      // The tab is the journalist's to close, and closing it is a legitimate
      // way to say "never mind" — it must not leave this promise pending.
      const watchdog = setInterval(() => {
        if (!browserPane.hasTab(tabId)) {
          done({ status: null, reason: 'the tab was closed before the page came up' })
        }
      }, TAB_WATCH_MS)

      const deadline = setTimeout(
        () => done({ status: null, reason: 'it timed out waiting for the page' }),
        HARD_TIMEOUT_MS
      )
    })
    // The tab is deliberately left open afterwards. Unlike a batch capture's
    // scratch tab, this one is a page the journalist asked to look at.
  }
}
