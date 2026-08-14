/**
 * Concurrency tests.
 *
 * These exist because local downloads run several at a time, and every write to
 * sources.csv is a read-modify-write over the whole file. Without serialisation
 * a finished capture is silently forgotten — the worst failure available here,
 * since nothing reports it.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addSource, createCollection } from '../src/main/sources/manual'
import { recordCapture } from '../src/main/sources/analyze'
import { readSources } from '../src/main/sources/csv'
import { withLock } from '../src/main/sources/lock'

async function collectionWith(urls: string[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bf-conc-'))
  const folder = await createCollection(root, 'c')
  for (const url of urls) await addSource(folder, { url })
  return folder
}

test('concurrent captures all survive', async () => {
  const urls = Array.from({ length: 12 }, (_, i) => `https://site${i}.com/a`)
  const folder = await collectionWith(urls)

  // Fire every capture at once, the way a batch of parallel downloads does.
  await Promise.all(
    urls.map((url, i) => recordCapture(folder, url, 'localPath', `archive/file${i}.mhtml`))
  )

  const links = await readSources(folder)
  const missing = links.filter((l) => !l.localPath)
  assert.deepEqual(
    missing.map((l) => l.url),
    [],
    'every concurrent capture must be recorded'
  )
})

test('concurrent captures to different fields of the same link all survive', async () => {
  const folder = await collectionWith(['https://a.com'])

  await Promise.all([
    recordCapture(folder, 'https://a.com', 'archiveIs', 'https://archive.ph/aaaaa'),
    recordCapture(folder, 'https://a.com', 'wayback', 'https://web.archive.org/web/1/a'),
    recordCapture(folder, 'https://a.com', 'localPath', 'archive/a.mhtml')
  ])

  const [link] = await readSources(folder)
  assert.equal(link.archiveIs, 'https://archive.ph/aaaaa')
  assert.equal(link.wayback, 'https://web.archive.org/web/1/a')
  assert.equal(link.localPath, 'archive/a.mhtml')
})

test('adding links concurrently keeps them all', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bf-conc-'))
  const folder = await createCollection(root, 'c')

  await Promise.all(
    Array.from({ length: 10 }, (_, i) => addSource(folder, { url: `https://x${i}.com` }))
  )

  assert.equal((await readSources(folder)).length, 10)
})

// ---- the lock itself ----

test('work queued on one key runs strictly in order', async () => {
  const order: number[] = []
  await Promise.all(
    [30, 20, 10, 0].map((delay, i) =>
      withLock('k', async () => {
        await new Promise((r) => setTimeout(r, delay))
        order.push(i)
      })
    )
  )
  assert.deepEqual(order, [0, 1, 2, 3])
})

test('different keys are not serialised against each other', async () => {
  let bStarted = false
  const a = withLock('a', async () => {
    await new Promise((r) => setTimeout(r, 40))
    // If the keys shared a queue, b could not have started yet.
    return bStarted
  })
  const b = withLock('b', async () => {
    bStarted = true
  })
  await b
  assert.equal(await a, true)
})

test('a failure does not poison the queue for later work', async () => {
  await assert.rejects(() => withLock('p', async () => { throw new Error('boom') }))
  assert.equal(await withLock('p', async () => 'fine'), 'fine')
})

test('the lock propagates the failure to its own caller', async () => {
  await assert.rejects(
    () => withLock('q', async () => { throw new Error('specific') }),
    /specific/
  )
})
