import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { captureFilename, screenshotFilename } from '../src/main/capture/local'
import { addSource, createCollection } from '../src/main/sources/manual'
import { recordCapture } from '../src/main/sources/analyze'
import { readSources } from '../src/main/sources/csv'

test('the screenshot shares the MHTML capture\'s base name, so the two are easy to pair up', () => {
  const url = 'https://www.nytimes.com/2026/05/15/world/x.html'
  const mhtml = captureFilename(url)
  const png = screenshotFilename(url)
  assert.equal(png, mhtml.replace(/\.mhtml$/, '.png'))
})

test('a screenshot survives a re-capture that could not read one', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bf-screenshot-'))
  const folder = await createCollection(root, 'c')
  const url = 'https://a.com'
  await addSource(folder, { url })

  await recordCapture(folder, url, 'localPath', 'archive/a.mhtml', 'A Title', 'archive/a.png')
  let [link] = await readSources(folder)
  assert.equal(link.screenshotPath, 'archive/a.png')

  // A later re-capture whose screenshot failed must not blank out the one
  // already on record — the file on disk did not go anywhere.
  await recordCapture(folder, url, 'localPath', 'archive/a.mhtml', 'A Title')
  ;[link] = await readSources(folder)
  assert.equal(link.screenshotPath, 'archive/a.png')
})
