/**
 * The capture adapter contract.
 *
 * Every preservation service is reduced to the same shape so the UI never
 * learns which one it is talking to. Backfile ships its own lightweight
 * adapters today; an ArchiveBox or Webrecorder adapter can be added later by
 * implementing this interface and registering it, with no change above.
 */

import { CaptureResult, ServiceId } from '../../shared/types'

export interface CaptureContext {
  /** Absolute path to the article folder, for adapters that write files. */
  articlePath: string
  /**
   * Aborted when the journalist presses Stop.
   *
   * Every adapter must honour this. Without it, "Stop" only stopped the queue
   * from advancing while the captures already in flight ran to completion —
   * which, with a 45-second page load timeout and four running at once, felt
   * like the button did nothing at all.
   */
  signal?: AbortSignal
  /**
   * Which browser's login cookies the video adapter may use, when a video
   * requires being signed in to watch. Every other adapter ignores this.
   */
  cookiesBrowser?: string | null
}

export interface CaptureAdapter {
  id: ServiceId
  label: string
  /**
   * True when a capture needs the journalist present — archive.is blocks
   * scripted submissions outright, so its captures are human-driven by design
   * rather than as a workaround.
   */
  requiresHuman: boolean
  /** Perform (or assist) a capture. */
  capture(url: string, ctx: CaptureContext): Promise<CaptureResult>
  /** Cheaply check for an existing snapshot, where the service permits it. */
  lookup?(url: string): Promise<string | null>
}

export function ok(
  service: ServiceId,
  url: string,
  value: string,
  title?: string,
  screenshotPath?: string
): CaptureResult {
  return { ok: true, service, url, value, title, screenshotPath }
}

export function fail(service: ServiceId, url: string, error: string): CaptureResult {
  return { ok: false, service, url, error }
}
