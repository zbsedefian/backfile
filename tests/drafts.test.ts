import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveDrafts,
  setDrafts,
  withResolution,
  type DraftIndex,
  type Resolution
} from '../src/main/project/drafts'

const DIR = '/w/CAM_02'
const DOCS = ['Blowback.docx', 'Jeremy Edit.docx', 'Taiwan-Ukraine drones.docx']

/** A folder mid-project: the sources.csv its imports wrote is still there. */
const resolve = (dir: string, docs: string[], index: DraftIndex): Resolution =>
  resolveDrafts(dir, docs, index, true)

test('a folder nobody has imported anything into starts empty', () => {
  const { drafts, record } = resolve(DIR, DOCS, {})
  assert.deepEqual(drafts, [])
  // Nothing to write: an absent entry and an explicit [] resolve identically,
  // so there is no reason to touch the settings file for a folder untouched.
  assert.equal(record, null)
})

test('an explicit choice is honoured', () => {
  const index: DraftIndex = { [DIR]: ['Blowback.docx'] }
  assert.deepEqual(resolve(DIR, DOCS, index).drafts, ['Blowback.docx'])
})

test('an empty choice really means none, not "never decided"', () => {
  const index: DraftIndex = { [DIR]: [] }
  const { drafts, record } = resolve(DIR, DOCS, index)
  assert.deepEqual(drafts, [])
  assert.equal(record, null)
})

test('drafts come back in folder order, not in the order they were stored', () => {
  const index: DraftIndex = { [DIR]: ['Taiwan-Ukraine drones.docx', 'Blowback.docx'] }
  assert.deepEqual(resolve(DIR, DOCS, index).drafts, [
    'Blowback.docx',
    'Taiwan-Ukraine drones.docx'
  ])
})

test('a chosen file deleted outside Backfile drops out', () => {
  const index: DraftIndex = { [DIR]: DOCS }
  const remaining = ['Blowback.docx', 'Jeremy Edit.docx']
  const { drafts, record } = resolve(DIR, remaining, index)
  assert.deepEqual(drafts, remaining)
  // The ghost is pruned rather than left to reappear if the name is reused.
  assert.deepEqual(record, remaining)
})

test('a settled folder is not rewritten on every scan', () => {
  const index: DraftIndex = { [DIR]: ['Blowback.docx'] }
  assert.equal(resolve(DIR, DOCS, index).record, null)
})

test('withResolution leaves the index alone when there is nothing to record', () => {
  const index: DraftIndex = { [DIR]: ['Blowback.docx'] }
  assert.equal(withResolution(index, DIR, null), index)
})

test('folders are independent of each other', () => {
  const index: DraftIndex = { [DIR]: ['Blowback.docx'] }
  const other = resolve('/w/CAM_01', ['a.docx'], index)
  assert.deepEqual(other.drafts, [])
  assert.deepEqual(resolve(DIR, DOCS, index).drafts, ['Blowback.docx'])
})

test('setDrafts stores the choice in folder order', () => {
  const next = setDrafts({}, DIR, DOCS, ['Taiwan-Ukraine drones.docx', 'Blowback.docx'])
  assert.deepEqual(next[DIR], ['Blowback.docx', 'Taiwan-Ukraine drones.docx'])
})

test('setDrafts ignores names that are not in the folder', () => {
  const next = setDrafts({}, DIR, DOCS, ['Blowback.docx', 'imaginary.docx'])
  assert.deepEqual(next[DIR], ['Blowback.docx'])
})

test('setDrafts can clear a folder entirely', () => {
  const next = setDrafts({ [DIR]: DOCS }, DIR, DOCS, [])
  assert.deepEqual(next[DIR], [])
})

test('unticking one file survives a rescan', () => {
  let index = setDrafts({}, DIR, DOCS, ['Blowback.docx', 'Jeremy Edit.docx'])
  const { drafts, record } = resolve(DIR, DOCS, index)
  index = withResolution(index, DIR, record)
  assert.deepEqual(drafts, ['Blowback.docx', 'Jeremy Edit.docx'])
  assert.deepEqual(resolve(DIR, DOCS, index).drafts, drafts)
})

test('importing one document at a time accumulates, each surviving a rescan', () => {
  // "Add article" appends to whatever is already there, one file per click.
  let index = setDrafts({}, DIR, DOCS, ['Blowback.docx'])
  index = setDrafts(index, DIR, DOCS, ['Blowback.docx', 'Jeremy Edit.docx'])
  assert.deepEqual(resolve(DIR, DOCS, index).drafts, [
    'Blowback.docx',
    'Jeremy Edit.docx'
  ])
})

test('moving sources.csv aside to start over drops the old imports', () => {
  // The settings entry outlives the folder's contents, so a project restarted
  // by renaming sources.csv would otherwise reopen still claiming three
  // imports — and the next "Add article", being additive, would analyse all of
  // them and file links from documents nobody picked this time.
  const index: DraftIndex = { [DIR]: DOCS }
  const { drafts, record } = resolveDrafts(DIR, DOCS, index, false)
  assert.deepEqual(drafts, [])
  assert.deepEqual(record, [])
})

test('a started-over folder stays empty until something is imported again', () => {
  let index: DraftIndex = { [DIR]: DOCS }
  index = withResolution(index, DIR, resolveDrafts(DIR, DOCS, index, false).record)
  assert.deepEqual(index[DIR], [])

  // The one document actually picked is the only one analysed — and once its
  // analysis has written sources.csv, that is what the folder resolves to.
  index = setDrafts(index, DIR, DOCS, ['Jeremy Edit.docx'])
  assert.deepEqual(resolve(DIR, DOCS, index).drafts, ['Jeremy Edit.docx'])
})

test('a folder with no sources.csv and no imports is not rewritten', () => {
  // Every article folder starts here, and rewriting settings for each one on
  // every scan would churn the file for nothing.
  assert.equal(resolveDrafts(DIR, DOCS, {}, false).record, null)
  assert.equal(resolveDrafts(DIR, DOCS, { [DIR]: [] }, false).record, null)
})
