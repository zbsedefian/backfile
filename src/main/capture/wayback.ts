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
       * GET /save/<percent-encoded url>, following the redirect to the snapshot.
       *
       * Two wrong turns are worth recording. Passing the URL raw in the path
       * meant its own query string was read as the save request's query string,
       * so any source carrying "?op=1" or a utm tag returned HTTP 500 while the
       * same URL without a query succeeded. Encoding the whole URL fixes that.
       *
       * Submitting it as a POST form fixes it too, but POST /save is the web
       * UI's asynchronous job endpoint: it answers 200 with a job page, no
       * redirect and no snapshot address, so there was nothing to record and
       * every capture reported "saved, but no snapshot URL was returned".
       */
      const res = await fetchWithTimeout(
        `https://web.archive.org/save/${encodeURIComponent(url)}`,
        SAVE_TIMEOUT_MS,
        {},
        ctx?.signal
      )

      if (res.status === 429) {
        return fail(
          'wayback',
          url,
          'rate limited by the Internet Archive — wait a few minutes and run it again'
        )
      }
      // 5xx here is usually the Archive failing to fetch the target rather than
      // the Archive being down — plenty of publishers block its crawler
      // outright. Saying so stops it reading as a bug in Backfile.
      if (res.status >= 500) {
        return fail(
          'wayback',
          url,
          `the Internet Archive could not fetch this page (HTTP ${res.status}) — ` +
            'many publishers block its crawler, so archive.is may be the only option here'
        )
      }
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
