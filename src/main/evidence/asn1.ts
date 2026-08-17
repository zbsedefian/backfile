/**
 * Just enough DER to speak RFC 3161.
 *
 * A timestamp request is a handful of nested SEQUENCEs and the reply is a
 * status code in front of an opaque CMS blob, so pulling in a full ASN.1 or
 * PKI library to do it would be several megabytes of dependency for about
 * ninety bytes of encoding. Backfile ships one runtime dependency on purpose:
 * a tool journalists are asked to trust with their evidence should be small
 * enough that someone could actually audit it.
 *
 * Deliberately narrow. This encodes the few types a TimeStampReq is built
 * from, and reads structure well enough to find the status and the TSA's
 * asserted time in a reply. It is not a general ASN.1 implementation and
 * should not be used as one — in particular it never validates a signature,
 * which is the verifier's job (see the report's own instructions for how the
 * standard tools do it).
 */

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30
} as const

/** DER length: short form under 128, otherwise a byte count then big-endian bytes. */
export function encodeLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  let rest = n
  while (rest > 0) {
    bytes.unshift(rest & 0xff)
    rest >>>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content])
}

export function derSequence(...parts: Buffer[]): Buffer {
  return tlv(TAG.SEQUENCE, Buffer.concat(parts))
}

export function derNull(): Buffer {
  return Buffer.from([TAG.NULL, 0x00])
}

export function derBoolean(value: boolean): Buffer {
  // DER, unlike BER, pins true to 0xff rather than "any non-zero byte".
  return Buffer.from([TAG.BOOLEAN, 0x01, value ? 0xff : 0x00])
}

export function derOctetString(content: Buffer): Buffer {
  return tlv(TAG.OCTET_STRING, content)
}

/**
 * A non-negative INTEGER, from a number or from raw big-endian bytes.
 *
 * The leading-zero rule is the part that bites: INTEGER is signed, so a nonce
 * whose first byte happens to be >= 0x80 encodes as a negative number unless a
 * zero byte is put in front of it. Roughly half of all random nonces hit that,
 * which makes it exactly the kind of bug that passes every test run but fails
 * one capture in two against a strict TSA.
 */
export function derInteger(value: number | Buffer): Buffer {
  let bytes: number[]
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`cannot encode ${value} as a DER INTEGER`)
    }
    bytes = []
    let rest = value
    do {
      bytes.unshift(rest & 0xff)
      rest = Math.floor(rest / 256)
    } while (rest > 0)
  } else {
    bytes = [...value]
    // Minimal encoding: strip leading zeros, but never the last byte.
    while (bytes.length > 1 && bytes[0] === 0x00 && (bytes[1] & 0x80) === 0) bytes.shift()
  }
  if (bytes.length === 0) bytes = [0]
  if (bytes[0] & 0x80) bytes.unshift(0x00)
  return tlv(TAG.INTEGER, Buffer.from(bytes))
}

/** An OBJECT IDENTIFIER from its dotted form, e.g. "2.16.840.1.101.3.4.2.1". */
export function derOid(dotted: string): Buffer {
  const parts = dotted.split('.').map((p) => {
    const n = Number(p)
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`bad OID component "${p}"`)
    return n
  })
  if (parts.length < 2) throw new Error(`bad OID "${dotted}"`)
  // The first two components share a byte, which is the one genuinely odd
  // thing about OID encoding.
  const bytes: number[] = [parts[0] * 40 + parts[1]]
  for (const value of parts.slice(2)) {
    const chunks: number[] = []
    let rest = value
    do {
      chunks.unshift(rest & 0x7f)
      rest >>>= 7
    } while (rest > 0)
    for (let i = 0; i < chunks.length - 1; i++) chunks[i] |= 0x80
    bytes.push(...chunks)
  }
  return tlv(TAG.OID, Buffer.from(bytes))
}

export interface Tlv {
  tag: number
  /** True for SEQUENCE, SET and any context-specific constructed tag. */
  constructed: boolean
  content: Buffer
  /** Offset just past this element, for walking a sequence of siblings. */
  end: number
}

/**
 * Read one DER element at `offset`.
 *
 * Throws rather than returning null on malformed input: every caller here is
 * parsing a reply from a timestamp authority, and a reply that is not valid
 * DER is an error worth surfacing, not something to silently skip past.
 */
export function readTlv(buffer: Buffer, offset = 0): Tlv {
  if (offset + 2 > buffer.length) throw new Error('truncated DER element')
  const tag = buffer[offset]
  const first = buffer[offset + 1]
  let length: number
  let headerLength: number
  if (first < 0x80) {
    length = first
    headerLength = 2
  } else {
    const count = first & 0x7f
    // 0x80 is BER's indefinite length, which DER forbids outright.
    if (count === 0) throw new Error('indefinite-length DER is not valid')
    if (count > 4) throw new Error('DER element too large to be a timestamp reply')
    if (offset + 2 + count > buffer.length) throw new Error('truncated DER length')
    length = 0
    for (let i = 0; i < count; i++) length = length * 256 + buffer[offset + 2 + i]
    headerLength = 2 + count
  }
  const start = offset + headerLength
  if (start + length > buffer.length) throw new Error('DER element runs past the end of the buffer')
  return {
    tag,
    constructed: (tag & 0x20) !== 0,
    content: buffer.subarray(start, start + length),
    end: start + length
  }
}

/** Every element directly inside a constructed one. */
export function children(node: Tlv): Tlv[] {
  const out: Tlv[] = []
  let offset = 0
  while (offset < node.content.length) {
    const child = readTlv(node.content, offset)
    out.push(child)
    offset = child.end
  }
  return out
}

/**
 * The first element with `tag`, in document order, anywhere in the tree.
 *
 * Used only to pull the TSA's asserted time out of a token for display. The
 * token's own bytes are what actually get stored and verified, so a structure
 * this does not understand costs a nicety, not evidence.
 */
export function findFirst(buffer: Buffer, tag: number): Buffer | null {
  let offset = 0
  while (offset < buffer.length) {
    let node: Tlv
    try {
      node = readTlv(buffer, offset)
    } catch {
      return null
    }
    if (node.tag === tag) return node.content
    if (node.constructed) {
      const found = findFirst(node.content, tag)
      if (found) return found
    }
    offset = node.end
  }
  return null
}
