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
import { CHROME_UA, probeViaChromium } from '../capture/local'
import { classifySettledPage, isBareHomepage } from './verifyPage'

const REQUEST_TIMEOUT_MS = 12_000

/**
 * Every check hits a different publisher, the same reasoning batch.ts gives
 * for local captures — but a HEAD request is far lighter than a full page
 * load, so this can afford to run more of them at once.
 */
const CONCURRENCY = 6
/**
 * The browser retry pass runs far narrower. Each one is a real Chromium
 * window rather than a socket, so this is held near the local-capture limit
 * for the same reason: memory and CPU, not politeness to any one host.
 */
const BROWSER_CONCURRENCY = 2
/** No pause needed: unlike archive.is or Wayback, there is no shared server here to overwhelm. */
const GAP_MS = 0

export interface CheckProgress {
  done: number
  total: number
  url: string
  /**
   * 'escalating' is the browser retry pass, which counts over its own much
   * shorter list rather than the whole run — otherwise it reports the plain
   * pass's finished total and looks stuck at 76/76 while it is still working.
   */
  phase: 'checking' | 'checked' | 'escalating' | 'finished'
  status?: LinkStatus
  /** Set only on the final 'finished' progress event. */
  checked?: number
  /** How many came back not-clean — confirmed gone or merely unverified alike. */
  flagged?: number
  /** How many needed the slower browser retry after the plain pass. */
  escalated?: number
  detail?: string
}

// Defined next door with the rest of the page-judging rules; re-exported here
// because this is the module link health is reached through.
export { isBareHomepage } from './verifyPage'

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

  if (res.ok) {
    if (res.redirected && isBareHomepage(res.url)) return 'redirected'
    return 'ok'
  }
  if (res.status === 404) return 'notfound'
  return 'servererror'
}

/**
 * Retry one URL in a real browser, for results the cheap pass could not settle.
 *
 * Most inconclusive results are not CAPTCHAs at all — they are pages that need
 * JavaScript, servers that sniff the user agent, or hosts that simply dislike
 * HEAD requests, and a genuine Chromium load walks through every one of them.
 * Running this over just the leftovers is what keeps the cost bounded: the
 * expensive path touches a handful of sources rather than hundreds.
 *
 * Judged by exactly the same rules a human verification is judged by, so
 * "Backfile watched the page load" means one thing in this app rather than
 * two. Returns null when it still cannot tell — a real CAPTCHA, a wall that
 * never clears — which leaves the cheap pass's verdict standing and the source
 * waiting for a person.
 */
export async function recheckViaBrowser(
  url: string,
  signal: AbortSignal
): Promise<LinkStatus | null> {
  const probe = await probeViaChromium(url, signal).catch(() => null)
  if (!probe || signal.aborted) return null
  const verdict = classifySettledPage({
    originalUrl: url,
    finalUrl: probe.finalUrl,
    title: probe.title,
    httpStatus: probe.httpStatus
  })
  return verdict.done ? verdict.status : null
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
    const results = new Map<string, LinkStatus>()

    const cancelControls = {
      isCancelled: () => this.cancelled,
      markCancelled: (): void => {
        this.cancelled = true
      }
    }

    // Pass one: a plain request for every source. Cheap enough for hundreds.
    const checkPlainly = async (link: SourceLink): Promise<QueueOutcome> => {
      onProgress({ done, total: queue.length, url: link.url, phase: 'checking' })
      const status = await checkOne(link.url, this.aborter.signal)
      if (status === 'cancelled') return 'cancelled'
      await recordLinkCheck(articlePath, link.url, status)
      results.set(link.url, status)
      done++
      onProgress({ done, total: queue.length, url: link.url, phase: 'checked', status })
      return 'ok'
    }

    await runQueue({
      items: queue,
      concurrency: CONCURRENCY,
      gapMs: GAP_MS,
      ...cancelControls,
      runOne: checkPlainly
    })

    /*
     * Pass two: whatever the cheap pass could not settle, retried in a real
     * browser. Deliberately scoped to the leftovers — that is what keeps a
     * headless window per source affordable, and it is where nearly all the
     * false "this source is rotten" readings were coming from.
     */
    const stubborn = queue.filter((l) => {
      const status = results.get(l.url)
      return status !== undefined && !isConclusive(status)
    })
    let escalated = 0

    const checkInBrowser = async (link: SourceLink): Promise<QueueOutcome> => {
      if (this.cancelled) return 'cancelled'
      // Counted against the stubborn list, not the whole run: this pass is
      // slow enough that a progress line frozen on the plain pass's final
      // total reads as a hang rather than as work still going on.
      onProgress({ done: escalated, total: stubborn.length, url: link.url, phase: 'escalating' })
      const status = await recheckViaBrowser(link.url, this.aborter.signal)
      if (this.cancelled) return 'cancelled'
      escalated++
      // Null means it is still behind something only a person can clear, so
      // the plain verdict already recorded stands.
      if (status) {
        await recordLinkCheck(articlePath, link.url, status)
        results.set(link.url, status)
      }
      onProgress({
        done: escalated,
        total: stubborn.length,
        url: link.url,
        phase: 'escalating',
        status: status ?? undefined
      })
      return 'ok'
    }

    if (stubborn.length > 0 && !this.cancelled) {
      await runQueue({
        items: stubborn,
        concurrency: BROWSER_CONCURRENCY,
        gapMs: 0,
        ...cancelControls,
        runOne: checkInBrowser
      })
    }

    const flagged = [...results.values()].filter((s) => s !== 'ok').length

    const final: CheckProgress = {
      done,
      total: queue.length,
      url: '',
      phase: 'finished',
      checked: done,
      flagged,
      escalated,
      detail: this.cancelled ? 'Stopped.' : undefined
    }
    onProgress(final)
    return final
  }
}
