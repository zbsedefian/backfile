import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanTrackingParams, normalizeUrl, isLikelyVideoPage } from '../src/shared/links'
import { scanWorkspace } from '../src/main/project/scan'

test('strips utm parameters', () => {
  assert.equal(
    cleanTrackingParams('https://mod.gov.ua/en/news/x?utm_source=chatgpt.com'),
    'https://mod.gov.ua/en/news/x'
  )
})

test('strips known click identifiers', () => {
  assert.equal(cleanTrackingParams('https://a.com/x?fbclid=123'), 'https://a.com/x')
  assert.equal(cleanTrackingParams('https://a.com/x?gclid=123'), 'https://a.com/x')
})

test('keeps parameters that address content', () => {
  // ?v= is the entire identity of a YouTube video; ?op= and ?id= address content.
  assert.equal(
    cleanTrackingParams('https://www.youtube.com/watch?v=abc123'),
    'https://www.youtube.com/watch?v=abc123'
  )
  assert.equal(cleanTrackingParams('https://a.com/x?op=1'), 'https://a.com/x?op=1')
  assert.equal(cleanTrackingParams('https://a.com/p?id=99'), 'https://a.com/p?id=99')
})

test('keeps the real parameters when mixed with tracking ones', () => {
  assert.equal(
    cleanTrackingParams('https://www.youtube.com/watch?v=abc&utm_source=x&si=y'),
    'https://www.youtube.com/watch?v=abc'
  )
})

test('leaves URLs without a query untouched', () => {
  assert.equal(cleanTrackingParams('https://a.com/x'), 'https://a.com/x')
})

test('the two tracked variants of one article collapse to the same URL', () => {
  const a = normalizeUrl('https://mod.gov.ua/en/news/story?utm_source=chatgpt.com')
  const b = normalizeUrl('https://mod.gov.ua/en/news/story')
  assert.equal(a, b)
})

test('normalize still strips trailing punctuation', () => {
  assert.equal(normalizeUrl('https://a.com/story.'), 'https://a.com/story')
})

test('recognises video hosts', () => {
  assert.ok(isLikelyVideoPage('https://www.youtube.com/watch?v=x'))
  assert.ok(isLikelyVideoPage('https://youtu.be/x'))
  assert.ok(isLikelyVideoPage('https://www.tiktok.com/@a/video/1'))
  assert.ok(!isLikelyVideoPage('https://nytimes.com/a'))
})

test('finds collections nested below the workspace root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bf-scan-'))
  await fs.mkdir(path.join(root, '2026', 'Investigations', 'CAM_09'), { recursive: true })
  await fs.writeFile(path.join(root, '2026', 'Investigations', 'CAM_09', 'draft.docx'), 'x')

  const found = await scanWorkspace(root)
  assert.equal(found.length, 1)
  // Named by relative path, so same-named folders in different years differ.
  assert.equal(found[0].name, '2026/Investigations/CAM_09')
})

test('does not descend into an article to find more articles', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bf-scan-'))
  await fs.mkdir(path.join(root, 'CAM_01', 'archive'), { recursive: true })
  await fs.writeFile(path.join(root, 'CAM_01', 'draft.docx'), 'x')
  await fs.writeFile(path.join(root, 'CAM_01', 'archive', 'notes.txt'), 'https://a.com')

  const found = await scanWorkspace(root)
  assert.deepEqual(found.map((a) => a.name), ['CAM_01'])
})

test('host-scoped tracking is only stripped on the hosts it belongs to', () => {
  // "si" is a share token on YouTube but could address content elsewhere.
  assert.equal(
    cleanTrackingParams('https://youtu.be/abc?si=xyz'),
    'https://youtu.be/abc'
  )
  assert.equal(
    cleanTrackingParams('https://someshop.com/p?si=xyz'),
    'https://someshop.com/p?si=xyz'
  )
})
