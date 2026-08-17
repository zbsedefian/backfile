/**
 * What counts as having actually verified a link.
 *
 * These exist because the previous attempt at this feature cleared a flag on
 * the click that opened the page, which verified nothing at all — a bot wall
 * would have been recorded as a healthy source. Every case below is about
 * refusing to record something the pane has not really shown yet.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { classifySettledPage, sameSite } from '../src/main/health/verifyPage'
import type { SettledInput } from '../src/main/health/verifyPage'

function settled(over: Partial<SettledInput> = {}): SettledInput {
  return {
    originalUrl: 'https://example.com/2024/an-article',
    finalUrl: 'https://example.com/2024/an-article',
    title: 'An article about a thing',
    httpStatus: 200,
    ...over
  }
}

// ---- still waiting: nothing may be recorded yet ----

test('a blank tab is not a verdict', () => {
  assert.deepEqual(classifySettledPage(settled({ finalUrl: 'about:blank' })), {
    done: false,
    waitingOn: 'blank'
  })
})

test('a Cloudflare interstitial is waited out, not recorded', () => {
  const verdict = classifySettledPage(settled({ title: 'Just a moment...' }))
  assert.deepEqual(verdict, { done: false, waitingOn: 'challenge' })
})

test('a challenge served as 403 is still waited out, not called an error', () => {
  // The exact false negative this feature exists to stop: Cloudflare answers
  // its own interstitial with a 403, and reading that as rot is what made
  // "Rotted" untrustworthy in the first place.
  const verdict = classifySettledPage(
    settled({ title: 'Attention Required! | Cloudflare', httpStatus: 403 })
  )
  assert.deepEqual(verdict, { done: false, waitingOn: 'challenge' })
})

test('a challenge served as 503 is waited out rather than read as a server error', () => {
  const verdict = classifySettledPage(
    settled({ title: 'Verify you are human', httpStatus: 503 })
  )
  assert.deepEqual(verdict, { done: false, waitingOn: 'challenge' })
})

test('wandering off to another site verifies nothing', () => {
  const verdict = classifySettledPage(
    settled({ finalUrl: 'https://www.google.com/search?q=an+article', title: 'an article' })
  )
  assert.deepEqual(verdict, { done: false, waitingOn: 'elsewhere' })
})

// ---- real verdicts ----

test('the real page loading on the source’s own site verifies it', () => {
  assert.deepEqual(classifySettledPage(settled()), { done: true, status: 'ok' })
})

test('a redirect to a new slug on the same site still counts as ok', () => {
  const verdict = classifySettledPage(
    settled({ finalUrl: 'https://example.com/2024/an-article-moved' })
  )
  assert.deepEqual(verdict, { done: true, status: 'ok' })
})

test('www and bare host are the same site', () => {
  const verdict = classifySettledPage(
    settled({ finalUrl: 'https://www.example.com/2024/an-article' })
  )
  assert.deepEqual(verdict, { done: true, status: 'ok' })
})

test('a real 404 on the source’s own site is confirmed gone', () => {
  const verdict = classifySettledPage(settled({ title: 'Page not available', httpStatus: 404 }))
  assert.deepEqual(verdict, { done: true, status: 'notfound' })
})

test('a 410 Gone is recorded the same way as a 404', () => {
  const verdict = classifySettledPage(settled({ title: 'Removed', httpStatus: 410 }))
  assert.deepEqual(verdict, { done: true, status: 'notfound' })
})

test('a genuine server error, with a real title, is recorded as one', () => {
  const verdict = classifySettledPage(settled({ title: 'Something went wrong', httpStatus: 500 }))
  assert.deepEqual(verdict, { done: true, status: 'servererror' })
})

test('landing on the bare homepage confirms the article itself is gone', () => {
  const verdict = classifySettledPage(
    settled({ finalUrl: 'https://example.com/', title: 'Example — Homepage' })
  )
  assert.deepEqual(verdict, { done: true, status: 'redirected' })
})

test('a source that was always a homepage is not called redirected', () => {
  const verdict = classifySettledPage(
    settled({
      originalUrl: 'https://example.com/',
      finalUrl: 'https://example.com/',
      title: 'Example — Homepage'
    })
  )
  assert.deepEqual(verdict, { done: true, status: 'ok' })
})

test('a page that reports no status at all is judged on where it landed', () => {
  const verdict = classifySettledPage(settled({ httpStatus: null }))
  assert.deepEqual(verdict, { done: true, status: 'ok' })
})

// ---- sameSite ----

test('sameSite ignores a leading www and the scheme', () => {
  assert.equal(sameSite('http://example.com/a', 'https://www.example.com/b'), true)
})

test('sameSite separates different hosts, including subdomains', () => {
  assert.equal(sameSite('https://example.com/a', 'https://evil.test/a'), false)
  assert.equal(sameSite('https://example.com/a', 'https://login.example.com/a'), false)
})

test('sameSite treats an unparseable URL as not matching', () => {
  assert.equal(sameSite('not a url', 'https://example.com'), false)
})
