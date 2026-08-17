import assert from 'node:assert/strict'
import test from 'node:test'
import { checkOne, isBareHomepage } from '../src/main/health/checkLinks'
import { parseCsv, rowsToLinks, serializeCsv } from '../src/main/sources/csv'
import type { SourceLink } from '../src/shared/types'

const realFetch = globalThis.fetch

function mockFetch(t: import('node:test').TestContext, impl: typeof fetch): void {
  globalThis.fetch = impl
  t.after(() => {
    globalThis.fetch = realFetch
  })
}

function response(over: { status: number; redirected?: boolean; url?: string }): Response {
  return {
    ok: over.status >= 200 && over.status < 300,
    status: over.status,
    redirected: over.redirected ?? false,
    url: over.url ?? 'https://example.com/article'
  } as Response
}

function link(over: Partial<SourceLink> = {}): SourceLink {
  return {
    url: 'https://example.com/a',
    anchorText: '',
    title: '',
    foundIn: [],
    articleSource: [],
    archiveIs: '',
    wayback: '',
    localPath: '',
    videoPath: '',
    screenshotPath: '',
    capturedAt: '',
    lastCheckedAt: '',
    linkStatus: '',
    verifiedBy: '',
    notes: '',
    excluded: false,
    excludedReason: '',
    ...over
  }
}

// ---- status mapping ----

test('a plain 200 is ok', async (t) => {
  mockFetch(t, (async () => response({ status: 200 })) as typeof fetch)
  const status = await checkOne('https://example.com/article', new AbortController().signal)
  assert.equal(status, 'ok')
})

test('404 maps to notfound', async (t) => {
  mockFetch(t, (async () => response({ status: 404 })) as typeof fetch)
  const status = await checkOne('https://example.com/gone', new AbortController().signal)
  assert.equal(status, 'notfound')
})

test('500 maps to servererror', async (t) => {
  mockFetch(t, (async () => response({ status: 500 })) as typeof fetch)
  const status = await checkOne('https://example.com/broken', new AbortController().signal)
  assert.equal(status, 'servererror')
})

test('a 400-class error other than 404 also maps to servererror', async (t) => {
  mockFetch(t, (async () => response({ status: 418 })) as typeof fetch)
  const status = await checkOne('https://example.com/teapot', new AbortController().signal)
  assert.equal(status, 'servererror')
})

test('a fetch that rejects with AbortError maps to timeout', async (t) => {
  mockFetch(
    t,
    (async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    }) as typeof fetch
  )
  const status = await checkOne('https://example.com/slow', new AbortController().signal)
  assert.equal(status, 'timeout')
})

test('a fetch that rejects with a network error maps to unreachable', async (t) => {
  mockFetch(
    t,
    (async () => {
      throw new Error('getaddrinfo ENOTFOUND example.invalid')
    }) as typeof fetch
  )
  const status = await checkOne('https://example.invalid/x', new AbortController().signal)
  assert.equal(status, 'unreachable')
})

test('a 405 to HEAD is retried with GET rather than reported as an error', async (t) => {
  const methods: string[] = []
  mockFetch(
    t,
    (async (_url: string, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET')
      return init?.method === 'HEAD' ? response({ status: 405 }) : response({ status: 200 })
    }) as typeof fetch
  )
  const status = await checkOne('https://example.com/head-blocked', new AbortController().signal)
  assert.equal(status, 'ok')
  assert.deepEqual(methods, ['HEAD', 'GET'])
})

// ---- the homepage-redirect case ----

test('a redirect to a specific new page still counts as ok', async (t) => {
  mockFetch(
    t,
    (async () =>
      response({ status: 200, redirected: true, url: 'https://example.com/article-moved' })) as typeof fetch
  )
  const status = await checkOne('https://example.com/article', new AbortController().signal)
  assert.equal(status, 'ok')
})

test('a redirect to the bare homepage is redirected, not ok', async (t) => {
  mockFetch(
    t,
    (async () => response({ status: 200, redirected: true, url: 'https://example.com/' })) as typeof fetch
  )
  const status = await checkOne('https://example.com/article', new AbortController().signal)
  assert.equal(status, 'redirected')
})

test('a 200 with no redirect at all is ok, never redirected', async (t) => {
  mockFetch(
    t,
    (async () => response({ status: 200, redirected: false, url: 'https://example.com/article' })) as typeof fetch
  )
  const status = await checkOne('https://example.com/article', new AbortController().signal)
  assert.equal(status, 'ok')
})

test('isBareHomepage: bare domain with or without a trailing slash', () => {
  assert.equal(isBareHomepage('https://example.com/'), true)
  assert.equal(isBareHomepage('https://example.com'), true)
})

test('isBareHomepage: a real path or a query string is not a bare homepage', () => {
  assert.equal(isBareHomepage('https://example.com/some-article'), false)
  assert.equal(isBareHomepage('https://example.com/?ref=x'), false)
})

// ---- CSV round-tripping ----

test('round-trips lastCheckedAt and linkStatus', () => {
  const original = link({ lastCheckedAt: '2026-08-17 12:00:00', linkStatus: 'notfound' })
  const back = rowsToLinks(parseCsv(serializeCsv([original])))
  assert.equal(back.length, 1)
  assert.deepEqual(back[0], original)
})

test('reads a sources.csv written before the link-check columns existed', () => {
  // No last_checked_at or link_status column at all — the shape of a file on
  // disk from before this feature shipped.
  const legacyColumns = [
    'status',
    'title',
    'url',
    'anchor_text',
    'archive_is',
    'wayback',
    'local_path',
    'video_path',
    'screenshot_path',
    'captured_at',
    'found_in',
    'article_source',
    'excluded',
    'excluded_reason',
    'notes'
  ]
  const values = legacyColumns.map((c) => (c === 'url' ? 'https://example.com/a' : ''))
  const csv = `${legacyColumns.join(',')}\n${values.join(',')}\n`

  const links = rowsToLinks(parseCsv(csv))
  assert.equal(links.length, 1)
  assert.equal(links[0].lastCheckedAt, '')
  assert.equal(links[0].linkStatus, '')
  assert.equal(links[0].verifiedBy, '')
})

test('a verified_by value the app does not recognise is read as unset', () => {
  const csv = 'url,verified_by\nhttps://example.com/a,somebody-else\n'
  assert.equal(rowsToLinks(parseCsv(csv))[0].verifiedBy, '')
})

test('a link_status value the app does not recognise is read as unchecked', () => {
  const csv = 'url,link_status,last_checked_at\nhttps://example.com/a,not-a-real-status,2026-08-17 12:00:00\n'
  const links = rowsToLinks(parseCsv(csv))
  assert.equal(links[0].linkStatus, '')
})
