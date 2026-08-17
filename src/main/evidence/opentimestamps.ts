/**
 * OpenTimestamps — the free timestamping option.
 *
 * A commercial TSA signs "I saw this hash at this time" with its own key, so
 * the proof is worth exactly what that authority's word is worth. Open-
 * Timestamps instead aggregates submitted hashes into a Merkle tree and
 * commits the root to the Bitcoin blockchain, so the proof is anchored to
 * something nobody can quietly re-sign later. It costs nothing, it needs no
 * account, and the calendar servers are run by several independent operators.
 *
 * The trade is latency: the Bitcoin attestation only exists once a block is
 * mined, typically within a few hours. What comes back immediately is a
 * calendar's promise to complete the proof, and the .ots file is "upgraded"
 * later with `ots upgrade`. For a capture that may be filed months afterwards
 * that is a good trade — the record is what matters, not the wait.
 *
 * Wire format is the OpenTimestamps proof serialisation, implemented here
 * directly rather than by shelling out to a Python client the journalist would
 * have to install first. Nothing but a 32-byte digest leaves the machine, and
 * because a random nonce is folded in before submission (below), the calendar
 * never learns even the capture's own hash.
 */

import { createHash, randomBytes } from 'node:crypto'

/**
 * Independent calendar operators, tried in order.
 *
 * The reference client submits to several at once for redundancy, which means
 * merging several proof trees into one file. Backfile takes the first calendar
 * that answers instead: one attestation from one operator is the same Bitcoin
 * anchor as any other, and a proof built by code simple enough to be read in
 * one sitting is worth more here than a slightly more redundant one.
 */
export const OTS_CALENDARS = [
  'https://a.pool.opentimestamps.org',
  'https://b.pool.opentimestamps.org',
  'https://alice.btc.calendar.opentimestamps.org',
  'https://finney.calendar.eternitywall.com'
] as const

/** `\x00OpenTimestamps\x00\x00Proof\x00` and the format's magic tail. */
const HEADER_MAGIC = Buffer.concat([
  Buffer.from([0x00]),
  Buffer.from('OpenTimestamps', 'ascii'),
  Buffer.from([0x00, 0x00]),
  Buffer.from('Proof', 'ascii'),
  Buffer.from([0x00]),
  Buffer.from('bf89e2e884e89294', 'hex')
])

const MAJOR_VERSION = 1

/** Operation tags from the proof format. */
const OP_SHA256 = 0x08
const OP_APPEND = 0xf0

const TIMEOUT_MS = 20_000

/** LEB128, as the proof format's varuint. */
export function varuint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`cannot encode ${value}`)
  if (value === 0) return Buffer.from([0x00])
  const bytes: number[] = []
  let rest = value
  while (rest > 0) {
    const byte = rest & 0x7f
    rest >>>= 7
    bytes.push(rest > 0 ? byte | 0x80 : byte)
  }
  return Buffer.from(bytes)
}

function varbytes(buffer: Buffer): Buffer {
  return Buffer.concat([varuint(buffer.length), buffer])
}

/**
 * What actually gets submitted: SHA-256 of the capture's digest with a random
 * nonce appended.
 *
 * The nonce is why this is safe to use on a journalist's sources. Submitting
 * the capture's own hash would let a calendar operator — or anyone who
 * subpoenaed one — test a guessed file against every submission ever made, and
 * so learn that this machine archived that exact page. Hashing a nonce in
 * first makes the submitted value meaningless to everyone except the holder of
 * the .ots file, while proving exactly as much.
 */
export function commitmentFor(fileDigest: Buffer, nonce: Buffer): Buffer {
  return createHash('sha256').update(Buffer.concat([fileDigest, nonce])).digest()
}

/**
 * Assemble a detached .ots proof.
 *
 * The file records the path from the capture's own digest to the value the
 * calendar attested: append the nonce, hash it, and then whatever the calendar
 * returned for that hash. `ots verify capture.mhtml` walks exactly that path.
 */
export function buildOtsProof(
  fileDigest: Buffer,
  nonce: Buffer,
  calendarProof: Buffer
): Buffer {
  if (fileDigest.length !== 32) throw new Error('a SHA-256 digest is 32 bytes')
  return Buffer.concat([
    HEADER_MAGIC,
    varuint(MAJOR_VERSION),
    // The op that produced the digest being attested — SHA-256 of the file.
    Buffer.from([OP_SHA256]),
    fileDigest,
    // …then the operations leading from that digest to the submitted value.
    Buffer.from([OP_APPEND]),
    varbytes(nonce),
    Buffer.from([OP_SHA256]),
    calendarProof
  ])
}

/** Submit a digest to one calendar and return its serialised proof. */
export async function submitToCalendar(
  calendar: string,
  commitment: Buffer,
  signal?: AbortSignal
): Promise<Buffer> {
  const response = await fetch(`${calendar.replace(/\/+$/, '')}/digest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/vnd.opentimestamps.v1'
    },
    // Node's Buffer type does not structurally satisfy fetch's BodyInit under
    // this project's lib config even though it is a Uint8Array at runtime; a
    // plain Uint8Array view over the same bytes does.
    body: new Uint8Array(commitment),
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`calendar answered ${response.status} ${response.statusText}`)
  }
  const proof = Buffer.from(await response.arrayBuffer())
  if (proof.length === 0) throw new Error('calendar returned an empty proof')
  return proof
}

export interface OtsToken {
  bytes: Buffer
  /** Which calendar answered, recorded so the manifest can name it. */
  calendar: string
}

/**
 * Timestamp a digest through the first calendar that answers.
 *
 * Every calendar failing is reported with the last error rather than silently
 * producing no token: a capture that quietly went un-timestamped is the one
 * thing worse than one that visibly did.
 */
export async function requestOtsToken(
  fileDigest: Buffer,
  calendars: readonly string[] = OTS_CALENDARS,
  signal?: AbortSignal
): Promise<OtsToken> {
  const nonce = randomBytes(16)
  const commitment = commitmentFor(fileDigest, nonce)

  let lastError: unknown = new Error('no calendars configured')
  for (const calendar of calendars) {
    try {
      const proof = await submitToCalendar(calendar, commitment, signal)
      return { bytes: buildOtsProof(fileDigest, nonce, proof), calendar }
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(
    `no OpenTimestamps calendar answered: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  )
}
