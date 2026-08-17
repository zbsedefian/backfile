/**
 * RFC 3161 timestamping.
 *
 * What this buys, and why it matters here: a capture's own file dates prove
 * nothing, because the journalist controls the machine that wrote them. A
 * timestamp authority is a third party who signs "I saw this exact SHA-256 at
 * this time" — so the capture can later be shown to have existed, unchanged,
 * before the date on the token. That is the difference between a file and an
 * exhibit.
 *
 * Only the hash ever leaves the machine. The TSA does not see the URL, the
 * page, or which article it belongs to, which keeps this compatible with the
 * promise that Backfile does not phone home about what anyone is reporting on.
 */

import { randomBytes } from 'node:crypto'
import { children, derBoolean, derInteger, derOctetString, derOid, derNull, derSequence, findFirst, readTlv, TAG } from './asn1'

/** id-sha256. */
const SHA256_OID = '2.16.840.1.101.3.4.2.1'

const REQUEST_TYPE = 'application/timestamp-query'
const REPLY_TYPE = 'application/timestamp-reply'

const TIMEOUT_MS = 20_000

/**
 * PKIStatus, from RFC 3161 §2.4.2. Anything but the first two means no token
 * came back at all.
 */
const STATUS_TEXT: Record<number, string> = {
  0: 'granted',
  1: 'granted with modifications',
  2: 'rejected',
  3: 'waiting',
  4: 'revocation warning',
  5: 'revocation notification'
}

/**
 * Build a TimeStampReq for a SHA-256 digest.
 *
 * ```
 * TimeStampReq ::= SEQUENCE {
 *   version        INTEGER { v1(1) },
 *   messageImprint MessageImprint,
 *   reqPolicy      TSAPolicyId OPTIONAL,
 *   nonce          INTEGER     OPTIONAL,
 *   certReq        BOOLEAN     DEFAULT FALSE,
 *   extensions     [0] IMPLICIT Extensions OPTIONAL }
 * ```
 *
 * `certReq` is asked for, because a token without the TSA's certificate in it
 * can only be verified by someone who already has that certificate — which is
 * precisely the person who will not be reading the filing years from now.
 *
 * The nonce is a replay guard: it comes back inside the signed token, so a
 * reply cannot be an old one for the same digest replayed by whatever sits
 * between here and the TSA.
 */
export function buildTimeStampRequest(digest: Buffer, nonce: Buffer = randomBytes(8)): Buffer {
  if (digest.length !== 32) throw new Error('a SHA-256 digest is 32 bytes')
  const messageImprint = derSequence(
    derSequence(derOid(SHA256_OID), derNull()),
    derOctetString(digest)
  )
  return derSequence(
    derInteger(1),
    messageImprint,
    derInteger(nonce),
    derBoolean(true)
  )
}

export interface TimeStampReply {
  granted: boolean
  status: number
  /** The TSA's own explanation, when it sent one. */
  statusText: string
  /** The TSA's asserted time, read from the token for display. */
  assertedTime?: string
}

/**
 * Read the status out of a TimeStampResp, and the asserted time out of its
 * token.
 *
 * ```
 * TimeStampResp ::= SEQUENCE {
 *   status         PKIStatusInfo,
 *   timeStampToken TimeStampToken OPTIONAL }
 * ```
 *
 * Nothing here validates the signature — that is deliberate. Verifying a
 * signature means shipping a trust store and deciding which authorities count,
 * which is a question for the court, not for the tool. Backfile's job is to
 * obtain the token, store it unaltered next to the bytes it attests, and print
 * the commands that let anyone else check it with `openssl ts`.
 */
export function parseTimeStampReply(buffer: Buffer): TimeStampReply {
  const outer = readTlv(buffer)
  if (outer.tag !== TAG.SEQUENCE) throw new Error('reply is not a TimeStampResp')
  const parts = children(outer)
  if (parts.length === 0) throw new Error('reply has no status')

  const statusInfo = children(parts[0])
  if (statusInfo.length === 0 || statusInfo[0].tag !== TAG.INTEGER) {
    throw new Error('reply has no PKIStatus')
  }
  let status = 0
  for (const byte of statusInfo[0].content) status = status * 256 + byte

  // PKIFreeText ::= SEQUENCE OF UTF8String — the TSA's reason for a refusal,
  // which is the only thing that makes a rejection actionable.
  const freeText = statusInfo
    .slice(1)
    .filter((p) => p.constructed)
    .flatMap((p) => children(p))
    .filter((p) => p.tag === TAG.UTF8_STRING)
    .map((p) => p.content.toString('utf8'))

  const granted = status === 0 || status === 1
  const token = parts[1]
  const assertedTime =
    granted && token ? parseGeneralizedTime(findFirst(token.content, TAG.GENERALIZED_TIME)) : undefined

  return {
    granted,
    status,
    statusText: freeText.join('; ') || STATUS_TEXT[status] || `status ${status}`,
    assertedTime
  }
}

/**
 * "20260816143005Z" and its fractional-second variants, as an ISO instant.
 *
 * Display only, so an unparseable time is simply not shown rather than
 * treated as an error: the authority's signed bytes are the record, and this
 * is the human-readable gloss on them.
 */
export function parseGeneralizedTime(content: Buffer | null): string | undefined {
  if (!content) return undefined
  const text = content.toString('ascii').trim()
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:[.,](\d+))?Z$/.exec(text)
  if (!match) return undefined
  const [, y, mo, d, h, mi, s, frac] = match
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${frac ? `.${frac.slice(0, 3)}` : ''}Z`
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

export interface Rfc3161Token {
  /** The whole TimeStampResp, stored verbatim — this is what `openssl ts` reads. */
  bytes: Buffer
  assertedTime?: string
}

/**
 * Ask a TSA to timestamp a digest.
 *
 * The complete response is kept, not just the token inside it, because that is
 * the form every standard tool expects: `openssl ts -verify -in x.tsr -data
 * x.mhtml` reads exactly these bytes. Storing the inner token instead would
 * save about thirty bytes and cost the person verifying it an afternoon.
 */
export async function requestRfc3161Token(
  tsaUrl: string,
  digest: Buffer,
  signal?: AbortSignal
): Promise<Rfc3161Token> {
  const nonce = randomBytes(8)
  const response = await fetch(tsaUrl, {
    method: 'POST',
    headers: { 'Content-Type': REQUEST_TYPE, Accept: REPLY_TYPE },
    // See the matching comment in opentimestamps.ts: Buffer needs an explicit
    // Uint8Array view to satisfy fetch's BodyInit typing here.
    body: new Uint8Array(buildTimeStampRequest(digest, nonce)),
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`timestamp authority answered ${response.status} ${response.statusText}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  const reply = parseTimeStampReply(bytes)
  if (!reply.granted) throw new Error(`timestamp refused: ${reply.statusText}`)
  return { bytes, assertedTime: reply.assertedTime }
}
