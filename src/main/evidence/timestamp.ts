/**
 * Which authority timestamps a capture, and where its token lands.
 *
 * Two schemes, one shape. OpenTimestamps is the default when timestamping is
 * turned on, because it is free, needs no account, and anchors to something no
 * single operator can revise; an RFC 3161 TSA is there for the newsroom or
 * firm whose counsel has already decided which authority they trust.
 *
 * Off by default, and that is a considered choice rather than an oversight.
 * Backfile's promise is that it does not talk to anyone about what a
 * journalist is working on, and timestamping is the one feature that has to
 * make a network request per capture. It is worth having, so it is one menu
 * click away — but turning it on should be a decision someone made, not a
 * default they never saw. Only a digest ever leaves the machine either way.
 */

import { DEFAULT_TSA_URL } from '../../shared/evidence'
import { requestOtsToken } from './opentimestamps'
import { requestRfc3161Token } from './rfc3161'

export type TimestampMode = 'off' | 'opentimestamps' | 'rfc3161'

export interface TimestampSettings {
  mode: TimestampMode
  /** Used when the mode is 'rfc3161'. */
  tsaUrl?: string
}

export { DEFAULT_TSA_URL }

export const DEFAULT_TIMESTAMP_SETTINGS: TimestampSettings = { mode: 'off' }

export interface IssuedToken {
  authority: 'opentimestamps' | 'rfc3161'
  /** The calendar or TSA that answered. */
  url: string
  /** Appended to the capture's own filename, so the pair is obvious on disk. */
  extension: '.ots' | '.tsr'
  bytes: Buffer
  /** The authority's own asserted time, where the scheme states one up front. */
  assertedTime?: string
}

/**
 * Obtain a token for a capture's digest, or null when timestamping is off.
 *
 * Throws on a network or protocol failure. Callers treat that as a warning
 * rather than a failed capture: an un-timestamped archive is still the page,
 * and losing the capture because a calendar server was down would be a poor
 * trade.
 */
export async function requestTimestamp(
  digest: Buffer,
  settings: TimestampSettings,
  signal?: AbortSignal
): Promise<IssuedToken | null> {
  if (settings.mode === 'off') return null

  if (settings.mode === 'rfc3161') {
    const url = settings.tsaUrl?.trim() || DEFAULT_TSA_URL
    const token = await requestRfc3161Token(url, digest, signal)
    return {
      authority: 'rfc3161',
      url,
      extension: '.tsr',
      bytes: token.bytes,
      assertedTime: token.assertedTime
    }
  }

  const token = await requestOtsToken(digest, undefined, signal)
  return {
    authority: 'opentimestamps',
    url: token.calendar,
    extension: '.ots',
    bytes: token.bytes
  }
}

/**
 * How a token is named on disk: the capture's own filename plus the token
 * extension, e.g. `reuters-com-x-1a2b3c4d.mhtml.ots`.
 *
 * Suffixing rather than replacing the extension is what the standard tools
 * expect — `ots verify page.mhtml.ots` looks for `page.mhtml` beside it — and
 * it means a folder of captures and tokens sorts into pairs.
 */
export function tokenFilenameFor(captureFilename: string, extension: string): string {
  return `${captureFilename}${extension}`
}

/** How to check a token by hand, printed into every capture report. */
export function verificationCommandFor(
  authority: 'opentimestamps' | 'rfc3161',
  captureFile: string,
  tokenFile: string
): string {
  return authority === 'opentimestamps'
    ? `ots verify "${tokenFile}"`
    : `openssl ts -verify -in "${tokenFile}" -data "${captureFile}" -CAfile <the authority's CA certificate>`
}
