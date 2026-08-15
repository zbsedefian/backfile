/**
 * What happens to sources a draft stops citing.
 *
 * The rows survive — a cut sentence is not a reason to throw away evidence —
 * but they have to become findable, because the only way to clean up a
 * reference document's links after unticking it is the orphaned view, and that
 * view is driven entirely by found_in being empty.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zipSync } from 'fflate'
import { analyzeArticle } from '../src/main/sources/analyze'

const enc = new TextEncoder()

function buildDocx(urls: string[]): Uint8Array {
  const rels = urls
    .map(
      (u, i) =>
        `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${u}" TargetMode="External"/>`
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

const MINE = 'https://example.com/my-source'
const THEIRS = 'https://example.com/their-source'

/** A folder holding the journalist's draft and a downloaded reference piece. */
async function folder(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bf-orphan-'))
  await fs.writeFile(path.join(dir, 'draft.docx'), buildDocx([MINE]))
  await fs.writeFile(path.join(dir, 'downloaded.docx'), buildDocx([THEIRS]))
  return dir
}

test('unticking a reference document leaves its links orphaned, not still cited', async () => {
  const dir = await folder()

  // Both read: the downloaded piece's links land in sources.csv as if cited.
  const first = await analyzeArticle(dir, ['draft.docx', 'downloaded.docx'])
  assert.equal(first.links.length, 2)
  const polluted = first.links.find((l) => l.url === THEIRS)
  assert.deepEqual(polluted?.foundIn, ['downloaded.docx'])

  // Untick it and analyse again.
  const second = await analyzeArticle(dir, ['draft.docx'])

  // The row survives, with its snapshots intact...
  assert.equal(second.links.length, 2)
  // ...but it no longer claims to be cited by a document nobody is reading.
  const stray = second.links.find((l) => l.url === THEIRS)
  assert.deepEqual(stray?.foundIn, [], 'a source no longer read must not name a document')

  // Which is exactly what the orphaned view filters on.
  assert.equal(second.orphaned, 1)
  assert.equal(second.links.filter((l) => l.foundIn.length === 0).length, 1)

  // The real citation is untouched.
  assert.deepEqual(second.links.find((l) => l.url === MINE)?.foundIn, ['draft.docx'])
})

test('the orphaned count and the orphaned view agree', async () => {
  const dir = await folder()
  await analyzeArticle(dir, ['draft.docx', 'downloaded.docx'])
  const result = await analyzeArticle(dir, [])
  assert.equal(result.orphaned, 2)
  assert.equal(result.links.filter((l) => l.foundIn.length === 0).length, result.orphaned)
})

test('re-ticking a document restores its found_in', async () => {
  const dir = await folder()
  await analyzeArticle(dir, ['draft.docx', 'downloaded.docx'])
  await analyzeArticle(dir, ['draft.docx'])
  const restored = await analyzeArticle(dir, ['draft.docx', 'downloaded.docx'])
  assert.deepEqual(
    restored.links.find((l) => l.url === THEIRS)?.foundIn,
    ['downloaded.docx']
  )
  assert.equal(restored.orphaned, 0)
})
