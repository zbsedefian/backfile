/**
 * How long ago something was recorded, in words.
 *
 * Exists for link checking, where the age of a result is part of how much it
 * is worth. A source verified by hand months ago reads identically to one
 * confirmed this morning unless the age is said out loud — and a hand
 * verification is exactly the kind that cannot refresh itself, because the
 * wall that made it necessary will still be there on the next automated pass.
 *
 * Deliberately coarse. The point is to separate "recent" from "a long time
 * ago" at a glance, not to be a clock.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/**
 * Timestamps are stored as "YYYY-MM-DD HH:MM:SS" in local time — the format
 * sources.csv uses so it reads plainly in Excel. Parsed as local rather than
 * handed to the Date constructor's UTC guess for the space-separated form.
 */
export function parseStamp(stamp: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(stamp.trim())
  if (!m) return null
  const date = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0)
  )
  return Number.isNaN(date.getTime()) ? null : date
}

export function describeAge(stamp: string, now: Date = new Date()): string {
  const then = parseStamp(stamp)
  if (!then) return ''
  const ms = now.getTime() - then.getTime()
  // A clock skew or a hand-edited future date reads as "just now" rather than
  // as a negative age.
  if (ms < MINUTE) return 'just now'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`
  if (ms < DAY) return `${Math.floor(ms / HOUR)} hr ago`
  if (ms < 2 * DAY) return 'yesterday'
  if (ms < MONTH) return `${Math.floor(ms / DAY)} days ago`
  if (ms < YEAR) {
    const months = Math.floor(ms / MONTH)
    return months === 1 ? 'a month ago' : `${months} months ago`
  }
  const years = Math.floor(ms / YEAR)
  return years === 1 ? 'a year ago' : `${years} years ago`
}

/**
 * Whether a check is old enough that its age is worth pointing out rather
 * than merely stating. Six months is a working guess at when a journalist
 * should look again before relying on it.
 */
export const STALE_AFTER_MS = 6 * MONTH

export function isStaleCheck(stamp: string, now: Date = new Date()): boolean {
  const then = parseStamp(stamp)
  if (!then) return false
  return now.getTime() - then.getTime() > STALE_AFTER_MS
}
