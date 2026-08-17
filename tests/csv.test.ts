import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCsv, rowsToLinks, serializeCsv } from '../src/main/sources/csv'
import { SourceLink } from '../src/shared/types'

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

test('parses quoted fields containing commas', () => {
  const rows = parseCsv('a,b\n"x,y",z\n')
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['x,y', 'z']
  ])
})

test('parses escaped double quotes', () => {
  assert.deepEqual(parseCsv('a\n"he said ""hi"""\n'), [['a'], ['he said "hi"']])
})

test('parses embedded newlines inside quotes', () => {
  assert.deepEqual(parseCsv('a\n"line1\nline2"\n'), [['a'], ['line1\nline2']])
})

test('handles CRLF line endings as a single terminator', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [
    ['a', 'b'],
    ['1', '2']
  ])
})

test('strips a UTF-8 BOM so the first header is not poisoned', () => {
  const rows = parseCsv('﻿url,notes\nhttps://x.com,hi\n')
  assert.equal(rows[0][0], 'url')
})

test('round-trips a link whose fields contain commas, quotes and newlines', () => {
  const original = link({
    url: 'https://example.com/a?x=1,2',
    anchorText: 'he said "look"',
    notes: 'line1\nline2',
    foundIn: ['draft one.docx', 'draft two.docx'],
    articleSource: ['draft one.docx', 'draft two.docx']
  })
  const back = rowsToLinks(parseCsv(serializeCsv([original])))
  assert.equal(back.length, 1)
  assert.deepEqual(back[0], original)
})

test('round-trips the excluded flag and its reason', () => {
  const original = link({ excluded: true, excludedReason: 'DOI' })
  const back = rowsToLinks(parseCsv(serializeCsv([original])))
  assert.equal(back[0].excluded, true)
  assert.equal(back[0].excludedReason, 'DOI')
})

test('ignores blank lines rather than emitting phantom sources', () => {
  const links = rowsToLinks(parseCsv('url,notes\n\nhttps://a.com,x\n\n'))
  assert.equal(links.length, 1)
})

test('skips rows with no URL', () => {
  assert.equal(rowsToLinks(parseCsv('url,notes\n,orphan note\n')).length, 0)
})

test('reads columns by name, not position, so column order may change', () => {
  const links = rowsToLinks(parseCsv('notes,archive_is,url\nhi,https://archive.ph/x,https://a.com\n'))
  assert.equal(links[0].url, 'https://a.com')
  assert.equal(links[0].archiveIs, 'https://archive.ph/x')
  assert.equal(links[0].notes, 'hi')
})

test('serialized status column reflects the tier', () => {
  const csv = serializeCsv([
    link({ url: 'https://a.com' }),
    link({ url: 'https://b.com', localPath: 'archive/b.mhtml' }),
    link({ url: 'https://c.com', archiveIs: 'https://archive.ph/c' }),
    link({
      url: 'https://d.com',
      archiveIs: 'https://archive.ph/d',
      wayback: 'https://web.archive.org/web/1/d',
      localPath: 'archive/d.mhtml'
    })
  ])
  const statuses = parseCsv(csv)
    .slice(1)
    .map((r) => r[0])
  assert.deepEqual(statuses, ['', 'bronze', 'silver', 'gold'])
})
