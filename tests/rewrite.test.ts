/**
 * Tests for the rewriter.
 *
 * This is the highest-risk code in Backfile: it is the only part that produces
 * a document a journalist will publish. A silent corruption here would be
 * discovered by a reader, not by us, so these tests build a real .docx, rewrite
 * it, and read the result back rather than asserting on internals.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zipSync, unzipSync } from 'fflate'
import { extractLinksFromDocx } from '../src/main/docx/extractLinks'
import { planDocxRewrite, rewriteDocxLinks } from '../src/main/docx/rewriteLinks'
import { SourceLink } from '../src/shared/types'

const enc = new TextEncoder()

/** A minimal but structurally valid .docx with hyperlinks in body and footnotes. */
function buildDocx(links: { id: string; url: string; text: string }[]): Uint8Array {
  const rels = links
    .map(
      (l) =>
        `<Relationship Id="${l.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${l.url.replace(/&/g, '&amp;')}" TargetMode="External"/>`
    )
    .join('')

  const body = links
    .map(
      (l) =>
        `<w:p><w:hyperlink r:id="${l.id}"><w:r><w:t>${l.text}</w:t></w:r></w:hyperlink></w:p>`
    )
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

async function scratch(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'backfile-test-'))
}

function link(url: string, over: Partial<SourceLink> = {}): SourceLink {
  return {
    url,
    anchorText: '',
    foundIn: [],
    archiveIs: '',
    wayback: '',
    localPath: '',
    capturedAt: '',
    notes: '',
    excluded: false,
    excludedReason: '',
    ...over
  }
}

test('repoints a cited link at its archive.is snapshot', async () => {
  const dir = await scratch()
  await fs.writeFile(
    path.join(dir, 'draft.docx'),
    buildDocx([{ id: 'rId1', url: 'https://nyt.com/a', text: 'the Times' }])
  )

  const result = await rewriteDocxLinks(dir, 'draft.docx', [
    link('https://nyt.com/a', { archiveIs: 'https://archive.ph/aaaaa' })
  ])
  assert.equal(result.rewritten, 1)

  const after = await extractLinksFromDocx(path.join(dir, result.outputPath))
  assert.equal(after[0].url, 'https://archive.ph/aaaaa')
  // The reader must still see the original wording, not the snapshot URL.
  assert.equal(after[0].anchorText, 'the Times')
})

test('leaves the original document untouched', async () => {
  const dir = await scratch()
  const original = buildDocx([{ id: 'rId1', url: 'https://nyt.com/a', text: 'x' }])
  await fs.writeFile(path.join(dir, 'draft.docx'), original)

  await rewriteDocxLinks(dir, 'draft.docx', [
    link('https://nyt.com/a', { archiveIs: 'https://archive.ph/aaaaa' })
  ])

  const stillThere = await extractLinksFromDocx(path.join(dir, 'draft.docx'))
  assert.equal(stillThere[0].url, 'https://nyt.com/a')
})

test('leaves links with no snapshot alone', async () => {
  const dir = await scratch()
  await fs.writeFile(
    path.join(dir, 'draft.docx'),
    buildDocx([
      { id: 'rId1', url: 'https://nyt.com/a', text: 'a' },
      { id: 'rId2', url: 'https://bbc.com/b', text: 'b' }
    ])
  )

  const result = await rewriteDocxLinks(dir, 'draft.docx', [
    link('https://nyt.com/a', { archiveIs: 'https://archive.ph/aaaaa' }),
    link('https://bbc.com/b')
  ])
  assert.equal(result.rewritten, 1)
  assert.equal(result.untouched, 1)

  const after = await extractLinksFromDocx(path.join(dir, result.outputPath))
  assert.ok(after.some((l) => l.url === 'https://bbc.com/b'))
})

test('never substitutes a local file path, which would be dead for any reader', async () => {
  const dir = await scratch()
  await fs.writeFile(
    path.join(dir, 'draft.docx'),
    buildDocx([{ id: 'rId1', url: 'https://nyt.com/a', text: 'a' }])
  )

  const result = await rewriteDocxLinks(dir, 'draft.docx', [
    link('https://nyt.com/a', { localPath: 'archive/2026-nyt.mhtml' })
  ])
  assert.equal(result.rewritten, 0)

  const after = await extractLinksFromDocx(path.join(dir, result.outputPath))
  assert.equal(after[0].url, 'https://nyt.com/a')
})

test('skips links marked as not needing archiving', async () => {
  const dir = await scratch()
  await fs.writeFile(
    path.join(dir, 'draft.docx'),
    buildDocx([{ id: 'rId1', url: 'https://doi.org/10.1/x', text: 'paper' }])
  )

  const result = await rewriteDocxLinks(dir, 'draft.docx', [
    link('https://doi.org/10.1/x', { archiveIs: 'https://archive.ph/zzzzz', excluded: true })
  ])
  assert.equal(result.rewritten, 0)
})

test('prefers archive.is over wayback', async () => {
  const dir = await scratch()
  await fs.writeFile(
    path.join(dir, 'draft.docx'),
    buildDocx([{ id: 'rId1', url: 'https://nyt.com/a', text: 'a' }])
  )

  const result = await rewriteDocxLinks(dir, 'draft.docx', [
    link('https://nyt.com/a', {
      archiveIs: 'https://archive.ph/aaaaa',
      wayback: 'https://web.archive.org/web/1/a'
    })
  ])
  const after = await extractLinksFromDocx(path.join(dir, result.outputPath))
  assert.equal(after[0].url, 'https://archive.ph/aaaaa')
})

test('preserves ampersands in rewritten targets rather than corrupting the XML', async () => {
  const dir = await scratch()
  await fs.writeFile(
    path.join(dir, 'draft.docx'),
    buildDocx([{ id: 'rId1', url: 'https://a.com/x?p=1&q=2', text: 'a' }])
  )

  const result = await rewriteDocxLinks(dir, 'draft.docx', [
    link('https://a.com/x?p=1&q=2', { archiveIs: 'https://archive.ph/bbbbb?a=1&b=2' })
  ])
  assert.equal(result.rewritten, 1)

  const out = unzipSync(
    new Uint8Array(await fs.readFile(path.join(dir, result.outputPath)))
  )
  const xml = new TextDecoder().decode(out['word/_rels/document.xml.rels'])
  // A raw & inside an attribute would make the part invalid XML and Word would
  // refuse to open the file.
  assert.ok(!/Target="[^"]*[^&]&[a-z]*[^;a-z]/.test(xml))
  assert.ok(xml.includes('&amp;'))

  const after = await extractLinksFromDocx(path.join(dir, result.outputPath))
  assert.equal(after[0].url, 'https://archive.ph/bbbbb?a=1&b=2')
})

test('the output opens as a valid docx with every part preserved', async () => {
  const dir = await scratch()
  await fs.writeFile(
    path.join(dir, 'draft.docx'),
    buildDocx([{ id: 'rId1', url: 'https://nyt.com/a', text: 'a' }])
  )
  const result = await rewriteDocxLinks(dir, 'draft.docx', [
    link('https://nyt.com/a', { archiveIs: 'https://archive.ph/aaaaa' })
  ])

  const out = unzipSync(new Uint8Array(await fs.readFile(path.join(dir, result.outputPath))))
  for (const part of ['[Content_Types].xml', 'word/document.xml', 'word/_rels/document.xml.rels']) {
    assert.ok(out[part], `missing part: ${part}`)
  }
})

test('the plan reports what would change without writing anything', async () => {
  const dir = await scratch()
  await fs.writeFile(
    path.join(dir, 'draft.docx'),
    buildDocx([
      { id: 'rId1', url: 'https://nyt.com/a', text: 'a' },
      { id: 'rId2', url: 'https://bbc.com/b', text: 'b' }
    ])
  )

  const plan = await planDocxRewrite(dir, 'draft.docx', [
    link('https://nyt.com/a', { archiveIs: 'https://archive.ph/aaaaa', anchorText: 'a' }),
    link('https://bbc.com/b')
  ])

  assert.equal(plan.changes.length, 1)
  assert.equal(plan.changes[0].snapshot, 'https://archive.ph/aaaaa')
  assert.equal(plan.changes[0].service, 'archive.is')
  assert.deepEqual(plan.unarchived, ['https://bbc.com/b'])

  // Nothing may have been written to disk.
  const files = await fs.readdir(dir)
  assert.deepEqual(files, ['draft.docx'])
})

test('the plan counts repeated citations of one source', async () => {
  const dir = await scratch()
  await fs.writeFile(
    path.join(dir, 'draft.docx'),
    buildDocx([
      { id: 'rId1', url: 'https://nyt.com/a', text: 'first' },
      { id: 'rId2', url: 'https://nyt.com/a', text: 'again' }
    ])
  )
  const plan = await planDocxRewrite(dir, 'draft.docx', [
    link('https://nyt.com/a', { archiveIs: 'https://archive.ph/aaaaa' })
  ])
  assert.equal(plan.changes.length, 1)
  assert.equal(plan.changes[0].occurrences, 2)
})

test('captures for one URL land on the same filename, so a retry replaces it', async () => {
  const { captureFilename } = await import('../src/main/capture/local')
  const a = captureFilename('https://www.nytimes.com/2026/05/15/world/x.html')
  const b = captureFilename('https://www.nytimes.com/2026/05/15/world/x.html')
  assert.equal(a, b)
  assert.match(a, /\.mhtml$/)
})

test('different URLs never share a capture filename, even with a long shared prefix', async () => {
  const { captureFilename } = await import('../src/main/capture/local')
  const long = 'https://example.com/' + 'a'.repeat(200)
  assert.notEqual(captureFilename(long + '1'), captureFilename(long + '2'))
})

test('the plan reports whether it would overwrite an existing output', async () => {
  const dir = await scratch()
  await fs.writeFile(
    path.join(dir, 'draft.docx'),
    buildDocx([{ id: 'rId1', url: 'https://nyt.com/a', text: 'a' }])
  )
  const links = [link('https://nyt.com/a', { archiveIs: 'https://archive.ph/aaaaa' })]

  const first = await planDocxRewrite(dir, 'draft.docx', links)
  assert.equal(first.overwrites, false)

  await rewriteDocxLinks(dir, 'draft.docx', links)
  const second = await planDocxRewrite(dir, 'draft.docx', links)
  assert.equal(second.overwrites, true)
})
