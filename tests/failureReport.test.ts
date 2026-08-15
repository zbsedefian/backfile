import test from 'node:test'
import assert from 'node:assert/strict'
import { formatFailureReport } from '../src/renderer/components/FailuresPanel'
import type { CaptureFailure } from '../src/renderer/App'

function failure(over: Partial<CaptureFailure> = {}): CaptureFailure {
  return {
    id: '1',
    source: 'archiveIs',
    url: 'https://example.com/a',
    message: 'net::ERR_CONNECTION_RESET',
    at: '2026-08-14T12:00:00.000Z',
    ...over
  }
}

test('the report leads with a count a reader can act on at a glance', () => {
  const text = formatFailureReport([failure(), failure({ id: '2' })])
  assert.match(text, /^Backfile — 2 failures/)
})

test('singular is grammatical for exactly one', () => {
  assert.match(formatFailureReport([failure()]), /1 failure\b(?! s)/)
  assert.doesNotMatch(formatFailureReport([failure()]), /1 failures/)
})

test('every url and message makes it into the text verbatim', () => {
  const text = formatFailureReport([
    failure({ url: 'https://example.com/x', message: 'timed out after 45s' })
  ])
  assert.match(text, /https:\/\/example\.com\/x/)
  assert.match(text, /timed out after 45s/)
})

test('a failure with no url (analyze, publish) is not shown as "undefined"', () => {
  const text = formatFailureReport([failure({ url: undefined, source: 'analyze' })])
  assert.doesNotMatch(text, /undefined/)
})

test('multiple failures each keep their own message, in order', () => {
  const text = formatFailureReport([
    failure({ id: '1', url: 'https://a.com', message: 'first message' }),
    failure({ id: '2', url: 'https://b.com', message: 'second message' })
  ])
  assert.ok(text.indexOf('first message') < text.indexOf('second message'))
})
