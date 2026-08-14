/**
 * Snapshots that were already in the document.
 *
 * Journalists routinely cite an archive link directly, having archived the page
 * months earlier. Treating those as unarchived sources put finished work back
 * into the queue and reported a secured citation as a gap.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zipSync } from 'fflate'
import { analyzeArticle } from '../src/main/sources/analyze'
import { tierOf } from '../src/shared/types'

const enc = new TextEncoder()

function buildDocx(urls: string[]): Uint8Array {
  const rels = urls
    .map(
      (u, i) =>
        `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${u.replace(/&/g, '&amp;')}" TargetMode="External"/>`
    )
    .join('')
  const body = urls
    .map((_, i) => `<w:p><w:hyperlink r:id="rId${i}"><w:r><w:t>cited</w:t></w:r></w:hyperlink></w:p>`)
    .join('')
  return zipSync({
    '[Content_Types].xml': enc.encode('<?xml version="1.0"?><Types/>'),
    'word/document.xml': enc.encode(
      `<?xml version="1.0"?><w:document xmlns:w="w" xmlns:r="r"><w:body>${body}</w:body></w:document>`
    ),
    'word/_rels/document.xml.rels': enc.encode(
      `<?xml version="1.0"?><Relationships>${rels}</Relationships>`
    )
  })
}

async function analyzeWith(urls: string[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bf-indoc-'))
  await fs.writeFile(path.join(dir, 'draft.docx'), buildDocx(urls))
  return analyzeArticle(dir, ['draft.docx'])
}

test('a cited archive.is link counts as already archived', async () => {
  const { links } = await analyzeWith(['https://archive.ph/KBKgK'])
  assert.equal(links.length, 1)
  assert.equal(links[0].archiveIs, 'https://archive.ph/KBKgK')
  assert.equal(tierOf(links[0]), 'silver')
})

test('a cited Wayback link is filed under the original it preserves', async () => {
  const { links } = await analyzeWith([
    'https://web.archive.org/web/20260101000000/https://nytimes.com/a'
  ])
  assert.equal(links[0].url, 'https://nytimes.com/a')
  assert.equal(links[0].wayback, 'https://web.archive.org/web/20260101000000/https://nytimes.com/a')
})

test('a Wayback citation merges with a plain citation of the same page', async () => {
  const { links } = await analyzeWith([
    'https://nytimes.com/a',
    'https://web.archive.org/web/20260101000000/https://nytimes.com/a'
  ])
  // One source, not two: the snapshot and the page are the same citation.
  assert.equal(links.length, 1)
  assert.equal(links[0].url, 'https://nytimes.com/a')
  assert.equal(links[0].wayback, 'https://web.archive.org/web/20260101000000/https://nytimes.com/a')
})

test('order does not matter when merging a snapshot with its original', async () => {
  const { links } = await analyzeWith([
    'https://web.archive.org/web/20260101000000/https://nytimes.com/a',
    'https://nytimes.com/a'
  ])
  assert.equal(links.length, 1)
  assert.equal(links[0].wayback, 'https://web.archive.org/web/20260101000000/https://nytimes.com/a')
})

test('counts in-document snapshots as imported, not as new work', async () => {
  const result = await analyzeWith(['https://archive.ph/KBKgK', 'https://bbc.com/x'])
  assert.equal(result.imported, 1)
  assert.equal(result.added, 2)
})

test('an ordinary source is still unarchived', async () => {
  const { links } = await analyzeWith(['https://bbc.com/x'])
  assert.equal(tierOf(links[0]), 'none')
})

test('the /wip/ form of an archive.is link is normalised', async () => {
  const { links } = await analyzeWith(['https://archive.is/wip/QE7sF'])
  // /wip/ stops resolving once the capture finishes, so it must not be stored.
  assert.equal(links[0].archiveIs, 'https://archive.ph/QE7sF')
})

test('re-analysing does not re-import what is already recorded', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bf-indoc-'))
  await fs.writeFile(path.join(dir, 'draft.docx'), buildDocx(['https://archive.ph/KBKgK']))
  await analyzeArticle(dir, ['draft.docx'])
  const again = await analyzeArticle(dir, ['draft.docx'])
  assert.equal(again.imported, 0)
  assert.equal(again.added, 0)
})

test('Backfile’s own published copy is not treated as a source document', async () => {
  const { isSourceDocument } = await import('../src/main/project/scan')
  assert.equal(isSourceDocument('CAM_01 draft.docx'), true)
  // Reading this back would re-ingest the archive links Backfile just wrote.
  assert.equal(isSourceDocument('CAM_01 draft (archived links).docx'), false)
  assert.equal(isSourceDocument('CAM_01 draft (Archived Links).docx'), false)
})
