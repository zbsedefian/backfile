/**
 * Saying how old a link check is.
 *
 * Matters because a hand verification is the one result that cannot refresh
 * itself — the wall that made it necessary answers every future automated
 * check the same way — so its age is all that separates it from a fresh one.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { describeAge, isStaleCheck, parseStamp } from '../src/shared/age'

/** The stamp format sources.csv uses, read as local time. */
const NOW = new Date(2026, 7, 17, 12, 0, 0)

function ago(ms: number): string {
  const d = new Date(NOW.getTime() - ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

test('parses the space-separated stamp sources.csv stores', () => {
  const d = parseStamp('2026-08-17 12:30:00')
  assert.equal(d?.getFullYear(), 2026)
  assert.equal(d?.getMonth(), 7)
  assert.equal(d?.getDate(), 17)
  assert.equal(d?.getHours(), 12)
})

test('parses a date with no time part', () => {
  assert.equal(parseStamp('2026-08-17')?.getDate(), 17)
})

test('an unparseable stamp yields nothing rather than a wrong date', () => {
  assert.equal(parseStamp(''), null)
  assert.equal(parseStamp('not a date'), null)
  assert.equal(describeAge('not a date', NOW), '')
})

test('describes recent checks in small units', () => {
  assert.equal(describeAge(ago(30_000), NOW), 'just now')
  assert.equal(describeAge(ago(5 * MINUTE), NOW), '5 min ago')
  assert.equal(describeAge(ago(3 * HOUR), NOW), '3 hr ago')
  assert.equal(describeAge(ago(30 * HOUR), NOW), 'yesterday')
  assert.equal(describeAge(ago(9 * DAY), NOW), '9 days ago')
})

test('describes older checks in months and years', () => {
  assert.equal(describeAge(ago(40 * DAY), NOW), 'a month ago')
  assert.equal(describeAge(ago(200 * DAY), NOW), '6 months ago')
  assert.equal(describeAge(ago(400 * DAY), NOW), 'a year ago')
  assert.equal(describeAge(ago(800 * DAY), NOW), '2 years ago')
})

test('a future stamp reads as just now rather than a negative age', () => {
  assert.equal(describeAge(ago(-5 * DAY), NOW), 'just now')
})

test('staleness turns over at six months', () => {
  assert.equal(isStaleCheck(ago(30 * DAY), NOW), false)
  assert.equal(isStaleCheck(ago(120 * DAY), NOW), false)
  assert.equal(isStaleCheck(ago(200 * DAY), NOW), true)
  assert.equal(isStaleCheck(ago(2 * 365 * DAY), NOW), true)
})

test('an unchecked source is never stale — there is nothing to be stale', () => {
  assert.equal(isStaleCheck('', NOW), false)
})
