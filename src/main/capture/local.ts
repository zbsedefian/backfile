/**
 * Local capture, using the Chromium that Electron already ships.
 *
 * This is the whole reason the app is worth building: a plain HTTP GET gets 403
 * from the NYT, Reuters and the Telegraph, because it is not a browser. A real
 * headless window executes the page's JavaScript, carries a real user agent, and
 * saves what a reader would actually have seen.
 *
 * Output is MHTML — one self-contained file per source, with images and CSS
 * inlined, that opens in any Chromium browser years later. A folder of loose
 * assets would not survive being moved, and that is the entire point.
 */

import { BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { CaptureAdapter, CaptureContext, fail, ok } from './types'
import { CaptureResult } from '../../shared/types'

/** Captures live beside the article they belong to, never in a global cache. */
export const CAPTURE_DIRNAME = 'archive'

export const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const LOAD_TIMEOUT_MS = 45_000
/**
 * How long to let a self-clearing JavaScript challenge finish before reading
 * the page during a link probe. Cloudflare's non-CAPTCHA interstitial takes a
 * few seconds to check the browser and navigate on by itself.
 */
const CHALLENGE_SETTLE_MS = 5_000
/** Time after load for lazy images and late scripts to settle before saving. */
const SETTLE_MS = 2_500
/**
 * How long to give the page's own 'load' event before giving up on it and
 * settling for 'dom-ready' instead.
 *
 * A news site's ad stack routinely embeds several tracking iframes right in
 * the initial HTML — ad-sync pixels, consent-sync beacons — each redirecting
 * in a loop that Chromium eventually cuts off, but not before it has kept the
 * page "loading" for a long time. The spec has the top-level 'load' event wait
 * for exactly those synchronously-embedded iframes, so a page can sit fully
 * rendered and readable while 'did-finish-load' never fires at all. A reader's
 * browser does not wait either — DOMContentLoaded is what makes an article
 * readable, 'load' is bookkeeping for a page's own asset pipeline.
 */
const DOM_READY_FALLBACK_MS = 6_000

/**
 * A stable, filesystem-safe name derived from the URL itself.
 *
 * Deliberately deterministic rather than timestamped. Re-capturing a source
 * then overwrites its own file instead of leaving the superseded one behind
 * forever, which is what a timestamp would do every single retry — and retries
 * are common, since a first capture often lands on a cookie wall. The capture
 * date lives in sources.csv, which is the right place for it anyway.
 *
 * The hash disambiguates URLs that share a truncated slug, so two different
 * pages on one site can never overwrite each other.
 */
/**
 * Whether a 'did-fail-load' event means the capture actually failed.
 *
 * A news site's ad stack routinely embeds several tracking iframes directly in
 * the page — ad-sync pixels, consent-sync beacons — each looping through
 * redirects that Chromium eventually cuts off. A real reader's browser does
 * not care that one of those failed; it renders the article regardless. Only a
 * failure of the main frame — the document savePage is actually going to
 * capture — is a real failure, and even there, code -3 (ERR_ABORTED) fires on
 * ordinary redirects with the main frame still ending up loaded.
 */
export function isRealLoadFailure(code: number, isMainFrame: boolean): boolean {
  return isMainFrame && code !== -3
}

function captureBasename(url: string): string {
  let slug: string
  try {
    const u = new URL(url)
    slug = `${u.hostname.replace(/^www\./, '')}${u.pathname}`
  } catch {
    slug = url
  }
  slug = slug
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 8)
  return `${slug || 'page'}-${hash}`
}

export function captureFilename(url: string): string {
  return `${captureBasename(url)}.mhtml`
}

/** Same base name as the MHTML capture, so the two are easy to tell apart on disk. */
export function screenshotFilename(url: string): string {
  return `${captureBasename(url)}.png`
}

interface CapturedPage {
  title: string
  /** Null when the screenshot itself failed — never worth failing the whole capture over. */
  screenshot: Buffer | null
}

/** Runs the load, saves the MHTML, and reads back the title and a screenshot. */
async function captureToFile(
  url: string,
  destination: string,
  signal?: AbortSignal
): Promise<CapturedPage> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      // The captured page is untrusted content: give it no bridge to the app.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      javascript: true,
      images: true,
      partition: 'persist:capture'
    }
  })

  // Destroying the window rejects its in-flight load, which is what makes Stop
  // immediate rather than "immediate once this page finishes loading".
  const onAbort = (): void => {
    if (!win.isDestroyed()) win.destroy()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    if (signal?.aborted) throw new Error('cancelled')
    win.webContents.setUserAgent(CHROME_UA)

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out after ${LOAD_TIMEOUT_MS / 1000}s`)),
        LOAD_TIMEOUT_MS
      )
      let domReadyTimer: NodeJS.Timeout | null = null
      // A page that redirects or reloads its main frame can fire 'dom-ready'
      // more than once, and idle listeners can still be in Electron's queue
      // the instant `done` runs. `settled` makes every path a no-op after the
      // first, so a late event can never call resolve/reject twice or reach
      // into a webContents that captureToFile has since destroyed.
      let settled = false
      const done = (err?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (domReadyTimer) clearTimeout(domReadyTimer)
        // Guarded because Stop gets here first: the abort handler destroys the
        // window, and the load it was waiting on then rejects straight into
        // this function. Reading .webContents off a destroyed window throws,
        // and on the timer path it throws inside a setTimeout callback where
        // nothing can catch it — which surfaced as errors on pressing Stop.
        if (!win.isDestroyed()) {
          win.webContents.removeListener('did-finish-load', onFinish)
          win.webContents.removeListener('did-fail-load', onFail)
          win.webContents.removeListener('dom-ready', onDomReady)
        }
        err ? reject(err) : resolve()
      }
      const onFinish = (): void => done()
      // Give 'load' a head start — it is the more complete signal when it
      // fires promptly — and only fall back to treating dom-ready as good
      // enough once it is clear 'load' is stuck behind an ad iframe rather
      // than genuinely still working.
      const onDomReady = (): void => {
        if (domReadyTimer) clearTimeout(domReadyTimer)
        domReadyTimer = setTimeout(done, DOM_READY_FALLBACK_MS)
      }
      // A real reader's browser does not care that an ad-tracking pixel or a
      // consent-sync beacon buried in the page failed to load — it renders the
      // article regardless. A capture that failed on every one of those would
      // be failing on almost nothing: kyivpost.com's article body loads fine
      // while a FreeWheel ad-sync iframe loops into ERR_TOO_MANY_REDIRECTS in
      // the background. Only a failure of the main frame itself — the thing
      // savePage is actually going to capture — is a real failure.
      const onFail = (
        _e: unknown,
        code: number,
        desc: string,
        _url: string,
        isMainFrame: boolean
      ): void => {
        if (isRealLoadFailure(code, isMainFrame)) done(new Error(`${desc} (${code})`))
      }
      win.webContents.on('did-finish-load', onFinish)
      win.webContents.on('did-fail-load', onFail)
      win.webContents.on('dom-ready', onDomReady)
      win.loadURL(url).catch(done)
    })

    await new Promise((r) => setTimeout(r, SETTLE_MS))
    await win.webContents.savePage(destination, 'MHTML')
    // Best-effort: a page whose capture succeeded is still worth keeping even
    // without a thumbnail, so a screenshot failure here is swallowed rather
    // than failing the whole local capture.
    const screenshot = await win.webContents
      .capturePage()
      .then((img) => img.toPNG())
      .catch(() => null)
    // Read after the settle, so a page that sets its real headline in script
    // has done so. Free: this window has the page loaded either way.
    return { title: win.webContents.getTitle(), screenshot }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    // Always tear the window down, or a failed capture leaks a live renderer.
    if (!win.isDestroyed()) win.destroy()
  }
}

export const localAdapter: CaptureAdapter = {
  id: 'local',
  label: 'Local copy',
  requiresHuman: false,

  async capture(url: string, ctx: CaptureContext): Promise<CaptureResult> {
    const dir = path.join(ctx.articlePath, CAPTURE_DIRNAME)
    const filename = captureFilename(url)
    const destination = path.join(dir, filename)
    // Capture aside, then move into place. Filenames are deterministic, so
    // writing directly would mean a failed re-capture destroys the perfectly
    // good snapshot that was already there.
    const staging = `${destination}.partial`
    try {
      await fs.mkdir(dir, { recursive: true })
      const { title, screenshot } = await captureToFile(url, staging, ctx.signal)
      await fs.rename(staging, destination)

      let screenshotPath = ''
      if (screenshot) {
        const screenshotName = screenshotFilename(url)
        // Same deterministic-overwrite reasoning as the MHTML above; failing
        // to write the thumbnail is not worth losing the capture itself over.
        try {
          await fs.writeFile(path.join(dir, screenshotName), screenshot)
          screenshotPath = path.join(CAPTURE_DIRNAME, screenshotName)
        } catch {
          // The capture itself already succeeded; a missing thumbnail is fine.
        }
      }

      // The stored path stays relative so the article folder can be moved,
      // renamed, synced or handed to an editor without breaking every row.
      return ok('local', url, path.join(CAPTURE_DIRNAME, filename), title, screenshotPath)
    } catch (err) {
      await fs.rm(staging, { force: true }).catch(() => undefined)
      if (ctx.signal?.aborted) return fail('local', url, 'cancelled')
      return fail('local', url, err instanceof Error ? err.message : String(err))
    }
  }
}

/** What a headless load actually found, for the link checker to judge. */
export interface BrowserProbe {
  /** Status of the last main-frame navigation, when one was reported. */
  httpStatus: number | null
  /** Where it ended up, after any redirects and any self-clearing challenge. */
  finalUrl: string
  /** The page's own title once it settled. */
  title: string
}

/**
 * Load a URL in a hidden Chromium window and report what came up.
 *
 * The escalation path for the link checker in ../health/checkLinks: a plain
 * HTTP request is turned away by the same bot detection this file's own doc
 * comment describes, and most of those refusals mean "not a browser" rather
 * than "the page is gone". A real window runs the page's JavaScript, carries
 * a real user agent, and gets through everything short of an actual CAPTCHA.
 *
 * Reports the title and final URL as well as the status because the status
 * alone cannot tell an article from a challenge page — Cloudflare serves its
 * interstitial as a perfectly ordinary 403 or 503.
 */
export async function probeViaChromium(
  url: string,
  signal?: AbortSignal
): Promise<BrowserProbe | null> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      javascript: true,
      images: false,
      partition: 'persist:capture'
    }
  })

  const onAbort = (): void => {
    if (!win.isDestroyed()) win.destroy()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    if (signal?.aborted) return null
    win.webContents.setUserAgent(CHROME_UA)

    return await new Promise<BrowserProbe | null>((resolve) => {
      let settled = false
      let status: number | null = null
      let settleTimer: NodeJS.Timeout | null = null

      const done = (probe: BrowserProbe | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (settleTimer) clearTimeout(settleTimer)
        // Same hazard as captureToFile above: Stop destroys the window while
        // the settle timer is still pending, and touching webContents then
        // throws out of a callback nothing is watching.
        if (!win.isDestroyed()) {
          win.webContents.removeListener('did-navigate', onNavigate)
          win.webContents.removeListener('did-fail-load', onFail)
          win.webContents.removeListener('did-stop-loading', onStop)
        }
        resolve(probe)
      }

      const timer = setTimeout(() => done(null), LOAD_TIMEOUT_MS)

      const onNavigate = (_e: unknown, _navUrl: string, httpResponseCode: number): void => {
        status = typeof httpResponseCode === 'number' ? httpResponseCode : null
      }
      const onFail = (
        _e: unknown,
        code: number,
        _desc: string,
        _navUrl: string,
        isMainFrame: boolean
      ): void => {
        if (isRealLoadFailure(code, isMainFrame)) done(null)
      }
      /**
       * A JavaScript challenge clears itself by navigating again a few seconds
       * after its interstitial finishes loading. Reading the page the instant
       * loading first stops would therefore report the wall for every walled
       * site — the pause is what lets the real article arrive, and the state is
       * read live afterwards so it reflects wherever the challenge landed.
       */
      const onStop = (): void => {
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = setTimeout(() => {
          if (win.isDestroyed()) return done(null)
          done({
            httpStatus: status,
            finalUrl: win.webContents.getURL(),
            title: win.webContents.getTitle()
          })
        }, CHALLENGE_SETTLE_MS)
      }

      win.webContents.on('did-navigate', onNavigate)
      win.webContents.on('did-fail-load', onFail)
      win.webContents.on('did-stop-loading', onStop)
      win.loadURL(url).catch(() => done(null))
    })
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (!win.isDestroyed()) win.destroy()
  }
}
