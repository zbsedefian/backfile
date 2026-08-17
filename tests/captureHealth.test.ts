/**
 * What a finished capture is allowed to claim about the source.
 *
 * These exist because "the capture succeeded" and "the source is fine" are not
 * the same statement, and conflating them cleared link-rot flags on the
 * strength of a saved bot-check page. Chromium writes a "Verifying you are
 * human" interstitial to MHTML exactly as happily as it writes an article.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addSource, createCollection } from '../src/main/sources/manual'
import { recordCapture } from '../src/main/sources/analyze'
import { readSources } from '../src/main/sources/csv'
import { overridesExisting, recordLinkCheck } from '../src/main/health/checkLinks'
import type { LinkStatus } from '../src/shared/types'

const URL = 'https://example.com/2024/an-article'

/** A collection holding one source, already flagged by an earlier check. */
async function flaggedCollection(status: LinkStatus | '' = 'unreachable'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bf-cap-health-'))
  const folder = await createCollection(root, 'c')
  await addSource(folder, { url: URL })
  const links = await readSources(folder)
  links[0].linkStatus = status
  links[0].lastCheckedAt = '2026-01-01 00:00:00'
  const { writeSources } = await import('../src/main/sources/csv')
  await writeSources(folder, links)
  return folder
}

test('a local capture that read a real headline clears the flag', async () => {
  const folder = await flaggedCollection()
  await recordCapture(folder, URL, 'localPath', 'archive/a.mhtml', 'A Real Headline About A Thing')
  const [link] = await readSources(folder)
  assert.equal(link.linkStatus, 'ok')
})

test('a local capture of a bot wall flags it instead of clearing it', async () => {
  const folder = await flaggedCollection()
  await recordCapture(folder, URL, 'localPath', 'archive/a.mhtml', 'Just a moment...')
  const [link] = await readSources(folder)
  assert.equal(
    link.linkStatus,
    'blocked',
    'a saved interstitial must never read as a healthy source'
  )
})

test('a local capture of an error page is flagged the same way', async () => {
  const folder = await flaggedCollection()
  await recordCapture(folder, URL, 'localPath', 'archive/a.mhtml', '404 Not Found')
  const [link] = await readSources(folder)
  assert.equal(link.linkStatus, 'blocked')
})

test('a clean source that captures a bot wall is newly flagged', async () => {
  // Not just "fails to clear" — this is the case where nothing had checked the
  // link yet and the capture itself is what turns up the problem.
  const folder = await flaggedCollection('')
  await recordCapture(folder, URL, 'localPath', 'archive/a.mhtml', 'Attention Required! | Cloudflare')
  const [link] = await readSources(folder)
  assert.equal(link.linkStatus, 'blocked')
  assert.notEqual(link.lastCheckedAt, '')
})

test('a downloaded video clears the flag on its own', async () => {
  const folder = await flaggedCollection()
  await recordCapture(folder, URL, 'videoPath', 'archive/a.mp4')
  const [link] = await readSources(folder)
  assert.equal(link.linkStatus, 'ok')
})

test('an archive.is snapshot leaves the flag alone rather than guessing', async () => {
  // A third party fetched the page; Backfile never saw what came back, and
  // archive.is will snapshot an error page without complaint.
  const folder = await flaggedCollection('notfound')
  await recordCapture(folder, URL, 'archiveIs', 'https://archive.ph/abcde')
  const [link] = await readSources(folder)
  assert.equal(link.linkStatus, 'notfound')
  assert.equal(link.lastCheckedAt, '2026-01-01 00:00:00')
})

test('a Wayback snapshot likewise claims nothing about the source', async () => {
  const folder = await flaggedCollection('redirected')
  await recordCapture(folder, URL, 'wayback', 'https://web.archive.org/web/1/a')
  const [link] = await readSources(folder)
  assert.equal(link.linkStatus, 'redirected')
})

test('a local capture reporting no title at all changes nothing either way', async () => {
  const folder = await flaggedCollection('timeout')
  await recordCapture(folder, URL, 'localPath', 'archive/a.mhtml')
  const [link] = await readSources(folder)
  assert.equal(link.linkStatus, 'timeout')
})

test('the capture itself is still recorded whatever the verdict', async () => {
  const folder = await flaggedCollection()
  await recordCapture(folder, URL, 'localPath', 'archive/a.mhtml', 'Just a moment...')
  const [link] = await readSources(folder)
  assert.equal(link.localPath, 'archive/a.mhtml', 'a flagged page is still a capture on disk')
  assert.notEqual(link.capturedAt, '')
})

// ---- re-checking must not undo human verification ----

test('an inconclusive re-check leaves a human verification standing', async () => {
  // The loop this prevents: a bot wall answers the automated check the same
  // way every run, so without this a source verified by hand falls back to
  // unverified on the very next "Check links" — forever.
  const folder = await flaggedCollection()
  await recordLinkCheck(folder, URL, 'ok', 'human')

  for (const inconclusive of ['timeout', 'unreachable', 'servererror'] as LinkStatus[]) {
    await recordLinkCheck(folder, URL, inconclusive)
    const [link] = await readSources(folder)
    assert.equal(link.linkStatus, 'ok', `${inconclusive} must not discard a human verification`)
    assert.equal(link.verifiedBy, 'human')
  }
})

test('an inconclusive re-check still records that it ran', async () => {
  const folder = await flaggedCollection()
  await recordLinkCheck(folder, URL, 'ok', 'human')
  const before = (await readSources(folder))[0].lastCheckedAt
  await new Promise((r) => setTimeout(r, 1100))
  await recordLinkCheck(folder, URL, 'timeout')
  const [link] = await readSources(folder)
  assert.notEqual(link.lastCheckedAt, before, 'the check did run, it just learned nothing better')
})

test('a conclusive re-check overrides a human verification', async () => {
  // A page that genuinely dies after being verified must still be caught.
  const folder = await flaggedCollection()
  await recordLinkCheck(folder, URL, 'ok', 'human')
  await recordLinkCheck(folder, URL, 'notfound')
  const [link] = await readSources(folder)
  assert.equal(link.linkStatus, 'notfound')
  assert.equal(link.verifiedBy, 'auto')
})

test('an automated verdict is freely replaced by another automated one', async () => {
  const folder = await flaggedCollection()
  await recordLinkCheck(folder, URL, 'ok')
  await recordLinkCheck(folder, URL, 'timeout')
  const [link] = await readSources(folder)
  assert.equal(link.linkStatus, 'timeout')
})

test('a capture of a bot wall cannot undo a human verification either', async () => {
  const folder = await flaggedCollection()
  await recordLinkCheck(folder, URL, 'ok', 'human')
  await recordCapture(folder, URL, 'localPath', 'archive/a.mhtml', 'Just a moment...')
  const [link] = await readSources(folder)
  assert.equal(link.linkStatus, 'ok')
  assert.equal(link.verifiedBy, 'human')
})

test('overridesExisting: conclusive always wins, inconclusive respects a human', () => {
  const human = { linkStatus: 'ok' as const, verifiedBy: 'human' as const }
  const auto = { linkStatus: 'ok' as const, verifiedBy: 'auto' as const }
  const fresh = { linkStatus: '' as const, verifiedBy: '' as const }

  assert.equal(overridesExisting(human, 'notfound'), true)
  assert.equal(overridesExisting(human, 'redirected'), true)
  assert.equal(overridesExisting(human, 'ok'), true)
  assert.equal(overridesExisting(human, 'timeout'), false)
  assert.equal(overridesExisting(human, 'blocked'), false)
  assert.equal(overridesExisting(auto, 'timeout'), true)
  assert.equal(overridesExisting(fresh, 'unreachable'), true)
})
