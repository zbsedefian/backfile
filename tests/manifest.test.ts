import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createCollection, addSource } from '../src/main/sources/manual'
import { recordCapture } from '../src/main/sources/analyze'
import { readSources } from '../src/main/sources/csv'
import {
  hashFile,
  readManifest,
  refreshManifest,
  resolveInProject,
  toPosixPath,
  verifyManifest
} from '../src/main/evidence/manifest'

const TOOL = 'Backfile 0.1.0 (test)'

/** A project with one source whose local capture is a real file on disk. */
async function setupCapturedProject(
  contents = '<html><head><title>Test page</title></head><body>hello</body></html>'
): Promise<{ root: string; folder: string; url: string; relativePath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bf-manifest-'))
  const folder = await createCollection(root, 'CAM_Manifest_Test')
  const url = 'https://example.com/article'
  await addSource(folder, { url })

  const archiveDir = path.join(folder, 'archive')
  await fs.mkdir(archiveDir, { recursive: true })
  const relativePath = path.join('archive', 'example-com-article.mhtml')
  await fs.writeFile(path.join(folder, relativePath), contents, 'utf8')

  await recordCapture(folder, url, 'localPath', relativePath, 'Test page')

  return { root, folder, url, relativePath }
}

test('refreshManifest adds one entry per captured file, with a matching hash', async () => {
  const { folder, relativePath } = await setupCapturedProject('hello world')
  const links = await readSources(folder)

  const result = await refreshManifest(folder, links, TOOL)

  assert.equal(result.added, 1)
  assert.equal(result.unchanged, 0)
  assert.equal(result.missing, 0)
  assert.equal(result.manifest.entries.length, 1)

  const entry = result.manifest.entries[0]
  assert.equal(entry.file, toPosixPath(relativePath))
  assert.equal(entry.url, 'https://example.com/article')
  assert.equal(entry.kind, 'local')
  assert.equal(entry.algorithm, 'sha256')
  assert.equal(entry.tool, TOOL)

  const expected = createHash('sha256').update('hello world').digest('hex')
  assert.equal(entry.sha256, expected)
  assert.equal(entry.bytes, Buffer.byteLength('hello world'))

  // Written to disk, not just returned — the manifest is meant to travel with
  // the project folder like sources.csv does.
  const onDisk = await readManifest(folder)
  assert.ok(onDisk)
  assert.equal(onDisk?.entries.length, 1)
  assert.equal(onDisk?.entries[0].sha256, expected)
})

test('refreshManifest never rewrites a hash already on record', async () => {
  const { folder, relativePath } = await setupCapturedProject('original bytes')
  const links = await readSources(folder)
  const first = await refreshManifest(folder, links, TOOL)
  const originalSha = first.manifest.entries[0].sha256

  // The file changes on disk without a re-capture — refreshing must not
  // notice. Only verification is allowed to report that kind of drift; a
  // background refresh silently re-recording it would be the exact failure
  // this file exists to prevent.
  await fs.writeFile(path.join(folder, relativePath), 'mutated bytes', 'utf8')
  const second = await refreshManifest(folder, links, TOOL)

  assert.equal(second.added, 0)
  assert.equal(second.unchanged, 1)
  assert.equal(second.manifest.entries[0].sha256, originalSha)
  assert.notEqual(
    second.manifest.entries[0].sha256,
    createHash('sha256').update('mutated bytes').digest('hex')
  )
})

test('verification passes when every captured file is untouched', async () => {
  const { folder } = await setupCapturedProject('hello world')
  const links = await readSources(folder)
  await refreshManifest(folder, links, TOOL)

  const report = await verifyManifest(folder)

  assert.equal(report.manifestExists, true)
  assert.equal(report.total, 1)
  assert.equal(report.ok, 1)
  assert.equal(report.modified, 0)
  assert.equal(report.missing, 0)
  assert.equal(report.unreadable, 0)
  assert.deepEqual(report.failures, [])
  assert.equal(report.entries[0].status, 'ok')
  assert.equal(report.entries[0].actual, report.entries[0].expected)
})

test('verification fails on a capture whose bytes changed after it was recorded', async () => {
  const { folder, relativePath } = await setupCapturedProject('original bytes')
  const links = await readSources(folder)
  await refreshManifest(folder, links, TOOL)

  await fs.writeFile(path.join(folder, relativePath), 'someone edited this file', 'utf8')

  const report = await verifyManifest(folder)

  assert.equal(report.total, 1)
  assert.equal(report.ok, 0)
  assert.equal(report.modified, 1)
  assert.equal(report.failures.length, 1)

  const [failure] = report.failures
  assert.equal(failure.status, 'modified')
  assert.equal(failure.file, toPosixPath(relativePath))
  const expectedNew = await hashFile(path.join(folder, relativePath))
  assert.equal(failure.actual, expectedNew.sha256)
  assert.notEqual(failure.actual, failure.expected)
})

test('verification reports a capture whose file was deleted as missing, not silently dropped', async () => {
  const { folder, relativePath } = await setupCapturedProject('will be deleted')
  const links = await readSources(folder)
  await refreshManifest(folder, links, TOOL)

  await fs.rm(path.join(folder, relativePath))

  const report = await verifyManifest(folder)

  assert.equal(report.total, 1)
  assert.equal(report.missing, 1)
  assert.equal(report.failures[0].status, 'missing')
  assert.equal(report.failures[0].actual, null)
})

test('verifying a project with no manifest reports that plainly, not as zero failures', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bf-manifest-empty-'))
  const folder = await createCollection(root, 'CAM_No_Manifest')

  const report = await verifyManifest(folder)

  assert.equal(report.manifestExists, false)
  assert.equal(report.total, 0)
  assert.deepEqual(report.failures, [])
})

test('a manifest path is resolved inside the project, and nothing else', () => {
  const project = '/w/CAM_01'
  assert.equal(resolveInProject(project, 'archive/a.mhtml'), path.resolve('/w/CAM_01/archive/a.mhtml'))
  // A manifest is a plain-text file journalists can edit, sync and email —
  // input, not a promise — so a path that tries to climb out of the project
  // must be refused rather than followed.
  assert.equal(resolveInProject(project, '../../etc/passwd'), null)
  assert.equal(resolveInProject(project, '/etc/passwd'), null)
})

test('refreshManifest records a capture as missing, not fabricated, when sources.csv names a file that is not on disk', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bf-manifest-missing-'))
  const folder = await createCollection(root, 'CAM_Missing_File')
  const url = 'https://example.com/gone'
  await addSource(folder, { url })
  // Recorded as captured, but the file itself was never written — e.g. moved
  // or deleted by hand outside Backfile.
  await recordCapture(folder, url, 'localPath', path.join('archive', 'gone.mhtml'), 'Gone')

  const links = await readSources(folder)
  const result = await refreshManifest(folder, links, TOOL)

  assert.equal(result.added, 0)
  assert.equal(result.missing, 1)
  assert.equal(result.manifest.entries.length, 0)
})
