/**
 * Whether a source belongs to a document the journalist has unticked.
 *
 * One rule, shared by the list, the pending counts, "capture all" and the
 * sidebar progress bar — see the note on isStranded in shared/types.ts for why
 * that sharing matters.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { isStranded, ownSources } from '../src/shared/types'
import type { SourceLink } from '../src/shared/types'

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
    notes: '',
    excluded: false,
    excludedReason: '',
    ...over
  }
}

test('cited only by an unticked document is stranded', () => {
  const l = link({ foundIn: ['downloaded.docx'] })
  assert.equal(isStranded(l, ['draft.docx']), true)
})

test('cited by a ticked document is not stranded', () => {
  const l = link({ foundIn: ['draft.docx'] })
  assert.equal(isStranded(l, ['draft.docx']), false)
})

test('cited by both a ticked and an unticked document is not stranded', () => {
  const l = link({ foundIn: ['draft.docx', 'downloaded.docx'] })
  assert.equal(isStranded(l, ['draft.docx']), false)
})

test('a hand-added link with no citing document is not stranded', () => {
  // foundIn empty means "no draft currently cites this", which already has its
  // own meaning (the orphaned filter) distinct from being unticked.
  const l = link({ foundIn: [] })
  assert.equal(isStranded(l, ['draft.docx']), false)
})

test('ownSources drops stranded rows and keeps the rest', () => {
  const article = {
    drafts: ['draft.docx'],
    sources: [
      link({ url: 'a', foundIn: ['draft.docx'] }),
      link({ url: 'b', foundIn: ['downloaded.docx'] }),
      link({ url: 'c', foundIn: [] })
    ]
  }
  assert.deepEqual(
    ownSources(article).map((l) => l.url),
    ['a', 'c']
  )
})
