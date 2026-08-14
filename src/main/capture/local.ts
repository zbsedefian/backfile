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
import path from 'node:path'
import { CaptureAdapter, CaptureContext, fail, ok } from './types'
import { CaptureResult } from '../../shared/types'

/** Captures live beside the article they belong to, never in a global cache. */
export const CAPTURE_DIRNAME = 'archive'

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const LOAD_TIMEOUT_MS = 45_000
/** Time after load for lazy images and late scripts to settle before saving. */
const SETTLE_MS = 2_500

/** A stable, filesystem-safe name derived from the URL itself. */
export function captureFilename(url: string, at = new Date()): string {
  let slug: string
  try {
    const u = new URL(url)
    slug = `${u.hostname}${u.pathname}`.replace(/^www\./, '')
  } catch {
    slug = url
  }
  slug = slug
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
  const stamp = at.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  return `${stamp}_${slug || 'page'}.mhtml`
}

async function captureToFile(url: string, destination: string): Promise<void> {
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

  try {
    win.webContents.setUserAgent(CHROME_UA)

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out after ${LOAD_TIMEOUT_MS / 1000}s`)),
        LOAD_TIMEOUT_MS
      )
      const done = (err?: Error): void => {
        clearTimeout(timer)
        err ? reject(err) : resolve()
      }
      win.webContents.once('did-finish-load', () => done())
      win.webContents.once('did-fail-load', (_e, code, desc) => {
        // -3 is ERR_ABORTED, which fires on ordinary redirects and cancelled
        // subresources; the main frame is still fine, so it is not a failure.
        if (code === -3) return
        done(new Error(`${desc} (${code})`))
      })
      win.loadURL(url).catch(done)
    })

    await new Promise((r) => setTimeout(r, SETTLE_MS))
    await win.webContents.savePage(destination, 'MHTML')
  } finally {
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
    try {
      await fs.mkdir(dir, { recursive: true })
      await captureToFile(url, destination)
      // The stored path stays relative so the article folder can be moved,
      // renamed, synced or handed to an editor without breaking every row.
      return ok('local', url, path.join(CAPTURE_DIRNAME, filename))
    } catch (err) {
      await fs.rm(destination, { force: true }).catch(() => undefined)
      return fail('local', url, err instanceof Error ? err.message : String(err))
    }
  }
}
