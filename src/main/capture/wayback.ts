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

async function fetchWithTimeout(url: string, ms: number, redirect: RequestRedirect = 'follow') {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect,
      headers: { 'User-Agent': 'Backfile/0.1 (journalist source archiving)' }
    })
  } finally {
    clearTimeout(timer)
  }
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

  async capture(url: string): Promise<CaptureResult> {
    const existing = await this.lookup!(url)
    if (existing) return ok('wayback', url, existing)

    try {
      const res = await fetchWithTimeout(
        `https://web.archive.org/save/${url}`,
        SAVE_TIMEOUT_MS
      )
      if (!res.ok) {
        return fail('wayback', url, `HTTP ${res.status}: ${res.statusText}`)
      }
      const location = res.headers.get('content-location')
      if (location) return ok('wayback', url, `https://web.archive.org${location}`)

      // Save succeeded but gave no snapshot header; ask the availability API,
      // which by now should know about the capture we just triggered.
      const confirmed = await this.lookup!(url)
      if (confirmed) return ok('wayback', url, confirmed)
      return fail('wayback', url, 'saved, but no snapshot URL was returned')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return fail('wayback', url, message.includes('abort') ? 'timed out' : message)
    }
  }
}
