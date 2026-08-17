import test from 'node:test'
import assert from 'node:assert/strict'
import { extractTitleFromMhtml } from '../src/main/capture/mhtmlTitle'

test('reads a plain title', () => {
  assert.equal(
    extractTitleFromMhtml('<html><head><title>Ukraine drones deal</title></head>'),
    'Ukraine drones deal'
  )
})

test('reads a title broken across a quoted-printable soft line break', () => {
  // Chromium wraps at 76 characters mid-word, with a trailing "=".
  const wrapped = '<title>Taiwan continues to provide financial and humanitarian sup=\r\nport</title>'
  assert.equal(
    extractTitleFromMhtml(wrapped),
    'Taiwan continues to provide financial and humanitarian support'
  )
})

test('decodes quoted-printable escapes, including multi-byte characters', () => {
  // "—" is E2 80 94 in UTF-8, which quoted-printable writes as three escapes.
  assert.equal(
    extractTitleFromMhtml('<title>Blowback =E2=80=94 Ukraine</title>'),
    'Blowback — Ukraine'
  )
})

test('an escape split across a soft break still decodes', () => {
  assert.equal(extractTitleFromMhtml('<title>a =E2=80=\r\n=94 b</title>'), 'a — b')
})

test('decodes HTML entities', () => {
  assert.equal(
    extractTitleFromMhtml('<title>Reuters &amp; the &quot;drone war&quot;</title>'),
    'Reuters & the "drone war"'
  )
  assert.equal(extractTitleFromMhtml('<title>caf&#233; raid</title>'), 'café raid')
})

test('collapses the whitespace a wrapped title picks up', () => {
  assert.equal(
    extractTitleFromMhtml('<title>\n   Spread   over\n   lines\n</title>'),
    'Spread over lines'
  )
})

test('handles attributes on the title tag', () => {
  assert.equal(extractTitleFromMhtml('<TITLE lang="en">Upper case tag</TITLE>'), 'Upper case tag')
})

test('a capture of a bot check yields no title rather than a useless one', () => {
  for (const junk of [
    '<title>Just a moment...</title>',
    '<title>Attention Required! | Cloudflare</title>',
    '<title>Access Denied</title>',
    '<title>403 Forbidden</title>',
    '<title>Verify you are human</title>',
    // Led by a status code, which an anchored match used to sail past.
    '<title>404 Not Found</title>',
    '<title>404 - Page Not Found</title>',
    '<title>500 Internal Server Error</title>'
  ]) {
    assert.equal(extractTitleFromMhtml(junk), '', junk)
  }
})

test('a real headline that merely starts with a number is kept', () => {
  // The status-code strip must not swallow these.
  assert.equal(
    extractTitleFromMhtml('<title>911 calls reveal a slow response</title>'),
    '911 calls reveal a slow response'
  )
  assert.equal(extractTitleFromMhtml('<title>500 Days of Summer</title>'), '500 Days of Summer')
})

test('an empty or absent title yields nothing', () => {
  assert.equal(extractTitleFromMhtml('<title></title>'), '')
  assert.equal(extractTitleFromMhtml('<html><head></head></html>'), '')
  assert.equal(extractTitleFromMhtml(''), '')
})

test('an absurdly long title is rejected as junk', () => {
  assert.equal(extractTitleFromMhtml(`<title>${'x'.repeat(400)}</title>`), '')
})

test('an unclosed title tag does not swallow the rest of the file', () => {
  assert.equal(extractTitleFromMhtml(`<title>${'x'.repeat(2000)}`), '')
})
