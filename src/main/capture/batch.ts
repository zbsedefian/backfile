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

/** Pause between archive.is submissions so a batch is not mistaken for an attack. */
const POLITE_GAP_MS = 1_200

/**
 * Local downloads run several at a time because each one hits a different
 * publisher, so there is no single service to overwhelm. archive.is is the
 * opposite: every request lands on one host that already treats automation as
 * hostile, and firing fifty at once is the fastest possible way to get the
 * journalist's IP banned from the service the whole app depends on. It also
 * cannot be parallelised even in principle — there is one capture tab, and a
 * CAPTCHA has to be answered by a human, once, in order.
 */
const LOCAL_CONCURRENCY = 4

export class BatchRunner {
  private cancelled = false
  private session: ArchiveIsSession | null = null

  cancel(): void {
    this.cancelled = true
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
        done: succeeded + failed,
        total: queue.length,
        url,
        phase: 'capturing'
      })

      const result =
        service === 'archiveIs' && this.session
          ? await this.session.capture(url)
          : await adapterFor(service).capture(url, { articlePath })

      if (result.ok && result.value) {
        await recordCapture(articlePath, url, FIELD_FOR[service], result.value)
        succeeded++
        onProgress({
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
        done: succeeded + failed,
        total: queue.length,
        url,
        phase: 'failed',
        detail: result.error
      })
      return 'failed'
    }

    if (service === 'archiveIs') {
      // Strictly one at a time: one tab, one CAPTCHA, answered in order.
      for (const link of queue) {
        if (this.cancelled) break
        if ((await runOne(link.url)) === 'cancelled') {
          this.cancelled = true
          break
        }
        if (!this.cancelled) await new Promise((r) => setTimeout(r, POLITE_GAP_MS))
      }
    } else {
      // Independent hosts, so a small pool of workers drains the queue together.
      const pending = [...queue]
      const worker = async (): Promise<void> => {
        while (!this.cancelled) {
          const next = pending.shift()
          if (!next) return
          if ((await runOne(next.url)) === 'cancelled') {
            this.cancelled = true
            return
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(LOCAL_CONCURRENCY, pending.length) }, worker)
      )
    }

    this.session?.close()
    this.session = null

    const final: BatchProgress = {
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
