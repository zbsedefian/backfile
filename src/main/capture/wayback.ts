/**
 * Wayback Machine adapter.
 *
 * Wayback is the one service here that answers scripted requests honestly, so
 * it gets a real lookup: checking for an existing snapshot before submitting a
 * new one avoids hammering an endpoint that returns 503 under load and usually
 * finds that the page was already captured years ago.
 */

import { CaptureAdapter, fail, ok } from './types'
import { CaptureResult } from '../../shared/types'

const AVAILABILITY_TIMEOUT_MS = 15_000
const SAVE_TIMEOUT_MS = 60_000

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

async function fetchWithTimeout(
  url: string,
  ms: number,
  init: RequestInit = {},
  external?: AbortSignal
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  // Stop must cut a request that is mid-flight, not merely stop the next one.
  const relay = (): void => controller.abort()
  external?.addEventListener('abort', relay, { once: true })
  if (external?.aborted) controller.abort()
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...init,
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) }
    })
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', relay)
  }
}

/** Pull the snapshot address out of whatever URL the save request landed on. */
function snapshotFrom(finalUrl: string): string | null {
  return /^https?:\/\/web\.archive\.org\/web\/\d+/.test(finalUrl)
    ? finalUrl.replace(/^http:\/\//, 'https://')
    : null
}

export const waybackAdapter: CaptureAdapter = {
  id: 'wayback',
  label: 'Wayback Machine',
  requiresHuman: false,

  async lookup(url: string): Promise<string | null> {
    try {
      const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`
      const res = await fetchWithTimeout(api, AVAILABILITY_TIMEOUT_MS)
      if (!res.ok) return null
      const data = (await res.json()) as {
        archived_snapshots?: { closest?: { available?: boolean; url?: string } }
      }
      const snap = data.archived_snapshots?.closest
      if (snap?.available && snap.url) {
        // The API hands back http:// even for pages archived over https.
        return snap.url.replace(/^http:\/\//, 'https://')
      }
      return null
    } catch {
      return null
    }
  },

  async capture(url: string, ctx?: { signal?: AbortSignal }): Promise<CaptureResult> {
    const existing = await this.lookup!(url)
    if (existing) return ok('wayback', url, existing)

    try {
      /*
       * Submitted as a POST form rather than GET /save/<url>.
       *
       * With the URL in the path, the target's own query string is read as the
       * save request's query string — so any source carrying "?op=1" or a utm
       * tag came back HTTP 500, while the identical URL without a query
       * succeeded. Putting the URL in the body removes the ambiguity entirely.
       */
      const res = await fetchWithTimeout(
        'https://web.archive.org/save',
        SAVE_TIMEOUT_MS,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ url }).toString()
        },
        ctx?.signal
      )

      if (!res.ok) return fail('wayback', url, `HTTP ${res.status}: ${res.statusText}`)

      // A successful save redirects to the snapshot it just made.
      const landed = snapshotFrom(res.url)
      if (landed) return ok('wayback', url, landed)

      const location = res.headers.get('content-location')
      if (location) return ok('wayback', url, `https://web.archive.org${location}`)

      // Saved but gave no snapshot address; ask the availability API, which by
      // now should know about the capture we just triggered.
      const confirmed = await this.lookup!(url)
      if (confirmed) return ok('wayback', url, confirmed)
      return fail('wayback', url, 'saved, but no snapshot URL was returned')
    } catch (err) {
      if (ctx?.signal?.aborted) return fail('wayback', url, 'cancelled')
      const message = err instanceof Error ? err.message : String(err)
      return fail('wayback', url, message.includes('abort') ? 'timed out' : message)
    }
  }
}
