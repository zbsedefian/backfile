/**
 * Batch capture.
 *
 * The archive.is CAPTCHA is per-session rather than per-URL, so a whole
 * article's worth of sources realistically costs one CAPTCHA at the start and
 * then runs unattended. This orchestrator exists to exploit that: it holds a
 * single browser session open across the queue rather than paying the cost
 * again for every link.
 *
 * Captures run strictly one at a time. Parallelism would be faster and would
 * also be the quickest possible way to get an IP banned by the very services
 * this depends on.
 */

import { ServiceId, SourceLink } from '../../shared/types'
import { ArchiveIsSession } from './archiveIs'
import { adapterFor } from './index'
import { recordCapture } from '../sources/analyze'

export interface BatchProgress {
  /** Which run this belongs to; several services may run at once. */
  service: ServiceId
  done: number
  total: number
  url: string
  /** 'capturing' | 'saved' | 'failed' | 'needs-human' | 'finished' */
  phase: 'capturing' | 'saved' | 'failed' | 'needs-human' | 'finished'
  detail?: string
  succeeded?: number
  failed?: number
}

const FIELD_FOR: Record<ServiceId, 'archiveIs' | 'wayback' | 'localPath' | 'videoPath'> = {
  archiveIs: 'archiveIs',
  wayback: 'wayback',
  local: 'localPath',
  video: 'videoPath'
}

/**
 * How hard each service may be pushed.
 *
 * Local copies are the only ones that parallelise: every download hits a
 * different publisher, so there is no single host to overwhelm. Everything else
 * lands on one server.
 *
 * archive.is cannot be parallelised even in principle — there is one capture
 * tab and a CAPTCHA a human answers once, in order. The Internet Archive rate
 * limits unauthenticated saves aggressively, and grouping it with the local
 * pool meant four concurrent submissions with no pause, which earned an
 * immediate 429 and made the whole run look broken. yt-dlp is held to one at a
 * time because each download is heavy on disk and CPU.
 */
const CONCURRENCY: Record<ServiceId, number> = {
  archiveIs: 1,
  wayback: 1,
  local: 4,
  video: 1
}

/** Pause between requests, so a batch is never mistaken for an attack. */
const GAP_MS: Record<ServiceId, number> = {
  archiveIs: 1_200,
  wayback: 3_000,
  local: 0,
  video: 0
}

export class BatchRunner {
  private cancelled = false
  private session: ArchiveIsSession | null = null
  /**
   * Aborts the captures already in flight, not just the queue.
   *
   * Stopping used to only prevent the next source from starting, so with four
   * local downloads running against a 45-second timeout the button appeared to
   * do nothing for the better part of a minute.
   */
  private readonly aborter = new AbortController()

  cancel(): void {
    this.cancelled = true
    this.aborter.abort()
    this.session?.cancel()
  }

  /** Abandon whatever is stuck and move to the next source. */
  skip(): void {
    this.session?.skip()
  }

  /** Which links still need this service, skipping excluded and already-captured ones. */
  static pending(links: SourceLink[], service: ServiceId): SourceLink[] {
    const field = FIELD_FOR[service]
    return links.filter((l) => !l.excluded && !l[field])
  }

  async run(
    articlePath: string,
    links: SourceLink[],
    service: ServiceId,
    onProgress: (p: BatchProgress) => void
  ): Promise<BatchProgress> {
    const queue = BatchRunner.pending(links, service)
    let succeeded = 0
    let failed = 0

    if (service === 'archiveIs') {
      this.session = new ArchiveIsSession((url) =>
        onProgress({
          service,
          done: succeeded + failed,
          total: queue.length,
          url,
          phase: 'needs-human',
          detail: 'Solve the CAPTCHA in the capture window — the rest will run on its own.'
        })
      )
      // Open the capture tab up front so the first CAPTCHA (if any) is already
      // visible in the pane rather than appearing 25 seconds into the run.
      this.session.prepare()
    }

    /** Run one source and fold its outcome into the counters. */
    const runOne = async (url: string): Promise<'ok' | 'failed' | 'cancelled'> => {
      onProgress({
        service,
        done: succeeded + failed,
        total: queue.length,
        url,
        phase: 'capturing'
      })

      const result =
        service === 'archiveIs' && this.session
          ? await this.session.capture(url)
          : await adapterFor(service).capture(url, {
              articlePath,
              signal: this.aborter.signal
            })

      if (result.ok && result.value) {
        await recordCapture(articlePath, url, FIELD_FOR[service], result.value)
        succeeded++
        onProgress({
          service,
          done: succeeded + failed,
          total: queue.length,
          url,
          phase: 'saved',
          detail: result.value
        })
        return 'ok'
      }

      // A cancel is a decision, not a failure, and must not be counted as one.
      if (result.error === 'cancelled') return 'cancelled'

      failed++
      onProgress({
        service,
        done: succeeded + failed,
        total: queue.length,
        url,
        phase: 'failed',
        detail: result.error
      })
      return 'failed'
    }

    const pending = [...queue]
    const gap = GAP_MS[service]
    const worker = async (): Promise<void> => {
      while (!this.cancelled) {
        const next = pending.shift()
        if (!next) return
        if ((await runOne(next.url)) === 'cancelled') {
          this.cancelled = true
          return
        }
        if (gap && !this.cancelled && pending.length > 0) {
          await new Promise((r) => setTimeout(r, gap))
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY[service], pending.length) }, worker)
    )

    this.session?.close()
    this.session = null

    const final: BatchProgress = {
      service,
      done: succeeded + failed,
      total: queue.length,
      url: '',
      phase: 'finished',
      succeeded,
      failed,
      detail: this.cancelled ? 'Stopped.' : undefined
    }
    onProgress(final)
    return final
  }
}
