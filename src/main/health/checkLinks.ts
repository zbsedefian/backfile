/**
 * Link-rot checking: for every non-excluded source, ask its original URL
 * whether it still resolves, and record what happened.
 *
 * A plain HTTP request is enough for almost every host — no JavaScript to
 * run, no ads to wait out, just a status code — which is what keeps this
 * cheap enough to run across hundreds of sources. Chromium, the expensive
 * path capture/local.ts pays for on every capture, is reserved here for the
 * one case a plain request cannot tell apart from real link rot: a 403 that
 * is bot-detection rather than the page actually being gone.
 */

import { LinkStatus, SourceLink } from '../../shared/types'
import { readSources, writeSources } from '../sources/csv'
import { withLock } from '../sources/lock'
import { runQueue, QueueOutcome } from '../capture/batch'
import { CHROME_UA, checkViaChromium } from '../capture/local'

const REQUEST_TIMEOUT_MS = 12_000

/**
 * Every check hits a different publisher, the same reasoning batch.ts gives
 * for local captures — but a HEAD request is far lighter than a full page
 * load, so this can afford to run more of them at once.
 */
const CONCURRENCY = 6
/** No pause needed: unlike archive.is or Wayback, there is no shared server here to overwhelm. */
const GAP_MS = 0

export interface CheckProgress {
  done: number
  total: number
  url: string
  phase: 'checking' | 'checked' | 'finished'
  status?: LinkStatus
  /** Set only on the final 'finished' progress event. */
  checked?: number
  /** How many came back not-clean — confirmed gone or merely unverified alike. */
  flagged?: number
  detail?: string
}

/**
 * A redirect that lands on nothing but the domain — no path, no query — is
 * the shape a removed or reorganised article takes almost every time: the
 * publisher's server still answers, it just has nothing left to say about
 * this specific page. A redirect that lands somewhere more specific (a new
 * slug, an https upgrade, a www-stripped host) is still the same article and
 * counts as resolving fine.
 */
export function isBareHomepage(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.pathname === '' || u.pathname === '/') && u.search === ''
  } catch {
    return false
  }
}

async function plainRequest(
  url: string,
  method: 'HEAD' | 'GET',
  parentSignal: AbortSignal
): Promise<Response> {
  const controller = new AbortController()
  const onParentAbort = (): void => controller.abort()
  parentSignal.addEventListener('abort', onParentAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': CHROME_UA }
    })
  } finally {
    clearTimeout(timer)
    parentSignal.removeEventListener('abort', onParentAbort)
  }
}

/** Checks one URL. Never throws — every outcome, including a dead link, is a successful check. */
export async function checkOne(
  url: string,
  parentSignal: AbortSignal
): Promise<LinkStatus | 'cancelled'> {
  if (parentSignal.aborted) return 'cancelled'

  let res: Response
  try {
    res = await plainRequest(url, 'HEAD', parentSignal)
    // Some servers reject HEAD outright rather than answering it truthfully.
    if (res.status === 405) res = await plainRequest(url, 'GET', parentSignal)
  } catch (err) {
    if (parentSignal.aborted) return 'cancelled'
    if (err instanceof Error && err.name === 'AbortError') return 'timeout'
    return 'unreachable'
  }

  if (res.status === 403) {
    // A 403 from a plain request is usually bot-detection, not link rot — see
    // this file's own doc comment. Ask a real browser instead of trusting it.
    const code = await checkViaChromium(url, parentSignal).catch(() => null)
    if (parentSignal.aborted) return 'cancelled'
    if (code === null) return 'unreachable'
    if (code === 404) return 'notfound'
    if (code >= 200 && code < 300) return 'ok'
    return 'servererror'
  }

  if (res.ok) {
    if (res.redirected && isBareHomepage(res.url)) return 'redirected'
    return 'ok'
  }
  if (res.status === 404) return 'notfound'
  return 'servererror'
}

/**
 * Outcomes trustworthy enough to overwrite anything already recorded.
 *
 * These are the ones a bot wall cannot manufacture: a page that actually
 * loaded, an explicit 404, a redirect that landed on the homepage. Everything
 * else — a timeout, an unreachable host, a server error, a captured
 * interstitial — is exactly what a wall produces when it turns away an
 * automated request, and so says nothing certain about the source.
 */
const CONCLUSIVE: ReadonlySet<string> = new Set<LinkStatus>([
  'ok',
  'notfound',
  'redirected'
])

export function isConclusive(status: LinkStatus): boolean {
  return CONCLUSIVE.has(status)
}

/**
 * Whether a fresh check may overwrite what is already recorded.
 *
 * "Check links" is a re-check: it runs across every source, including ones
 * already settled, because a page that resolved last month can be gone today.
 * The single exception is that an inconclusive automated result may not
 * discard a human verification — the journalist got past a wall the checker
 * cannot, and re-flagging that source every run would make verifying it by
 * hand pointless work. A conclusive result still wins, so a source that
 * genuinely dies after being verified is still caught.
 */
export function overridesExisting(
  existing: Pick<SourceLink, 'linkStatus' | 'verifiedBy'>,
  incoming: LinkStatus
): boolean {
  if (isConclusive(incoming)) return true
  return existing.verifiedBy !== 'human' || existing.linkStatus === ''
}

/**
 * Record one check against a single link and persist it.
 *
 * Locked on the same key recordCapture uses, so a link check and a capture
 * racing on the same article never clobber each other's write — see
 * withLock's own doc comment for why a shared key across every kind of write
 * matters once more than one thing can be running at once.
 */
export async function recordLinkCheck(
  articlePath: string,
  url: string,
  status: LinkStatus,
  by: 'auto' | 'human' = 'auto'
): Promise<SourceLink[]> {
  return withLock(articlePath, async () => {
    const links = await readSources(articlePath)
    const link = links.find((l) => l.url === url)
    if (!link) return links
    // A human's first-hand look outranks an inconclusive automated result.
    // The timestamp still moves: the check did run, it just learned nothing
    // that beats what is already recorded.
    if (by === 'auto' && !overridesExisting(link, status)) {
      link.lastCheckedAt = new Date().toISOString().slice(0, 19).replace('T', ' ')
      await writeSources(articlePath, links)
      return links
    }
    link.linkStatus = status
    link.verifiedBy = by
    link.lastCheckedAt = new Date().toISOString().slice(0, 19).replace('T', ' ')
    await writeSources(articlePath, links)
    return links
  })
}

export class LinkCheckRunner {
  private cancelled = false
  private readonly aborter = new AbortController()

  cancel(): void {
    this.cancelled = true
    this.aborter.abort()
  }

  /** Which links a check run covers: every source, excluded ones aside — a DOI resolves permanently and has nothing to check. */
  static pending(links: SourceLink[]): SourceLink[] {
    return links.filter((l) => !l.excluded)
  }

  async run(
    articlePath: string,
    links: SourceLink[],
    onProgress: (p: CheckProgress) => void
  ): Promise<CheckProgress> {
    const queue = LinkCheckRunner.pending(links)
    let done = 0
    let flagged = 0

    const runOne = async (link: SourceLink): Promise<QueueOutcome> => {
      onProgress({ done, total: queue.length, url: link.url, phase: 'checking' })
      const status = await checkOne(link.url, this.aborter.signal)
      if (status === 'cancelled') return 'cancelled'
      await recordLinkCheck(articlePath, link.url, status)
      done++
      if (status !== 'ok') flagged++
      onProgress({ done, total: queue.length, url: link.url, phase: 'checked', status })
      return 'ok'
    }

    await runQueue({
      items: queue,
      concurrency: CONCURRENCY,
      gapMs: GAP_MS,
      isCancelled: () => this.cancelled,
      markCancelled: () => {
        this.cancelled = true
      },
      runOne
    })

    const final: CheckProgress = {
      done,
      total: queue.length,
      url: '',
      phase: 'finished',
      checked: done,
      flagged,
      detail: this.cancelled ? 'Stopped.' : undefined
    }
    onProgress(final)
    return final
  }
}
