import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addSource, createCollection, parsePastedLink, removeSource, updateSourceUrl } from '../src/main/sources/manual'
import { readSources } from '../src/main/sources/csv'
import { tierOf } from '../src/shared/types'

async function scratch(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'backfile-manual-'))
}

// ---- recognising what was pasted ----

test('an ordinary URL is just a source', () => {
  const p = parsePastedLink('https://nytimes.com/a')
  assert.equal(p.url, 'https://nytimes.com/a')
  assert.equal(p.archiveIs, '')
  assert.equal(p.snapshotOnly, false)
})

test('a Wayback URL is split into snapshot and original', () => {
  const p = parsePastedLink('https://web.archive.org/web/20260101000000/https://nytimes.com/a')
  assert.equal(p.url, 'https://nytimes.com/a')
  assert.equal(p.wayback, 'https://web.archive.org/web/20260101000000/https://nytimes.com/a')
})

test('a Wayback URL with a modifier suffix still splits', () => {
  const p = parsePastedLink('https://web.archive.org/web/20260101000000if_/https://nytimes.com/a')
  assert.equal(p.url, 'https://nytimes.com/a')
})

test('an archive.is link is recognised as an already-permanent address', () => {
  const p = parsePastedLink('https://archive.is/KBKgK')
  assert.equal(p.archiveIs, 'https://archive.ph/KBKgK')
  assert.equal(p.snapshotOnly, true)
})

test('the /wip/ form is normalised, since it stops resolving once done', () => {
  const p = parsePastedLink('https://archive.is/wip/QE7sF')
  assert.equal(p.archiveIs, 'https://archive.ph/QE7sF')
})

test('every archive.is mirror is recognised', () => {
  for (const host of ['archive.ph', 'archive.is', 'archive.today', 'archive.li']) {
    assert.equal(parsePastedLink(`https://${host}/AbCd1`).archiveIs, 'https://archive.ph/AbCd1')
  }
})

// ---- collections ----

test('creates a collection with an empty sources.csv ready to fill', async () => {
  const root = await scratch()
  const folder = await createCollection(root, 'CAM_05 Test Piece')
  assert.equal(path.basename(folder), 'CAM_05 Test Piece')
  assert.deepEqual(await readSources(folder), [])
})

test('refuses to adopt an existing folder', async () => {
  const root = await scratch()
  await createCollection(root, 'dupe')
  await assert.rejects(() => createCollection(root, 'dupe'), /already exists/)
})

test('strips path separators out of a collection name', async () => {
  const root = await scratch()
  const folder = await createCollection(root, 'a/b:c')
  assert.equal(path.basename(folder), 'a-b-c')
  assert.equal(path.dirname(folder), root)
})

// ---- adding links ----

test('adds a plain link as an unarchived source', async () => {
  const root = await scratch()
  const folder = await createCollection(root, 'c')
  const { links } = await addSource(folder, { url: 'https://nytimes.com/a' })
  assert.equal(links[0].url, 'https://nytimes.com/a')
  assert.equal(tierOf(links[0]), 'none')
})

test('an archive.is link saves as already archived', async () => {
  const root = await scratch()
  const folder = await createCollection(root, 'c')
  const { links } = await addSource(folder, { url: 'https://archive.is/KBKgK' })
  assert.equal(links[0].url, 'https://archive.ph/KBKgK')
  assert.equal(links[0].archiveIs, 'https://archive.ph/KBKgK')
  // It is a permanent address already, so it must not sit in the work queue.
  assert.equal(tierOf(links[0]), 'silver')
})

test('a Wayback link saves under its original URL', async () => {
  const root = await scratch()
  const folder = await createCollection(root, 'c')
  const { links } = await addSource(folder, {
    url: 'https://web.archive.org/web/20260101000000/https://bbc.com/x'
  })
  assert.equal(links[0].url, 'https://bbc.com/x')
  assert.equal(tierOf(links[0]), 'bronze')
})

test('adding the same URL twice merges rather than duplicating', async () => {
  const root = await scratch()
  const folder = await createCollection(root, 'c')
  await addSource(folder, { url: 'https://nytimes.com/a' })
  const { links, merged } = await addSource(folder, {
    url: 'https://nytimes.com/a',
    archiveIs: 'https://archive.ph/aaaaa'
  })
  assert.equal(merged, true)
  assert.equal(links.length, 1)
  assert.equal(links[0].archiveIs, 'https://archive.ph/aaaaa')
})

test('merging never overwrites a snapshot that is already recorded', async () => {
  const root = await scratch()
  const folder = await createCollection(root, 'c')
  await addSource(folder, { url: 'https://a.com', archiveIs: 'https://archive.ph/first' })
  const { links } = await addSource(folder, {
    url: 'https://a.com',
    archiveIs: 'https://archive.ph/second'
  })
  assert.equal(links[0].archiveIs, 'https://archive.ph/first')
})

test('a DOI added by hand is excluded automatically', async () => {
  const root = await scratch()
  const folder = await createCollection(root, 'c')
  const { links } = await addSource(folder, { url: 'https://doi.org/10.1/x' })
  assert.equal(links[0].excluded, true)
})

test('added links survive a write/read round-trip', async () => {
  const root = await scratch()
  const folder = await createCollection(root, 'c')
  await addSource(folder, { url: 'https://archive.is/KBKgK', notes: 'evidence' })
  const reread = await readSources(folder)
  assert.equal(reread.length, 1)
  assert.equal(reread[0].notes, 'evidence')
  assert.equal(reread[0].archiveIs, 'https://archive.ph/KBKgK')
})

test('a source URL can be corrected later', async () => {
  const root = await scratch()
  const folder = await createCollection(root, 'c')
  await addSource(folder, { url: 'https://archive.is/KBKgK' })
  const links = await updateSourceUrl(folder, 'https://archive.ph/KBKgK', 'https://real.com/story')
  assert.equal(links[0].url, 'https://real.com/story')
  // The snapshot must survive the correction.
  assert.equal(links[0].archiveIs, 'https://archive.ph/KBKgK')
})

test('removing a source drops only that row', async () => {
  const root = await scratch()
  const folder = await createCollection(root, 'c')
  await addSource(folder, { url: 'https://a.com' })
  await addSource(folder, { url: 'https://b.com' })
  const links = await removeSource(folder, 'https://a.com')
  assert.deepEqual(
    links.map((l) => l.url),
    ['https://b.com']
  )
})
