import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveDrafts,
  setDrafts,
  withResolution,
  type DraftIndex
} from '../src/main/project/drafts'

const DIR = '/w/CAM_02'
const DOCS = ['Blowback.docx', 'Jeremy Edit.docx', 'Taiwan-Ukraine drones.docx']

test('a folder nobody has imported anything into starts empty', () => {
  const { drafts, record } = resolveDrafts(DIR, DOCS, {})
  assert.deepEqual(drafts, [])
  // Nothing to write: an absent entry and an explicit [] resolve identically,
  // so there is no reason to touch the settings file for a folder untouched.
  assert.equal(record, null)
})

test('an explicit choice is honoured', () => {
  const index: DraftIndex = { [DIR]: ['Blowback.docx'] }
  assert.deepEqual(resolveDrafts(DIR, DOCS, index).drafts, ['Blowback.docx'])
})

test('an empty choice really means none, not "never decided"', () => {
  const index: DraftIndex = { [DIR]: [] }
  const { drafts, record } = resolveDrafts(DIR, DOCS, index)
  assert.deepEqual(drafts, [])
  assert.equal(record, null)
})

test('drafts come back in folder order, not in the order they were stored', () => {
  const index: DraftIndex = { [DIR]: ['Taiwan-Ukraine drones.docx', 'Blowback.docx'] }
  assert.deepEqual(resolveDrafts(DIR, DOCS, index).drafts, [
    'Blowback.docx',
    'Taiwan-Ukraine drones.docx'
  ])
})

test('a chosen file deleted outside Backfile drops out', () => {
  const index: DraftIndex = { [DIR]: DOCS }
  const remaining = ['Blowback.docx', 'Jeremy Edit.docx']
  const { drafts, record } = resolveDrafts(DIR, remaining, index)
  assert.deepEqual(drafts, remaining)
  // The ghost is pruned rather than left to reappear if the name is reused.
  assert.deepEqual(record, remaining)
})

test('a settled folder is not rewritten on every scan', () => {
  const index: DraftIndex = { [DIR]: ['Blowback.docx'] }
  assert.equal(resolveDrafts(DIR, DOCS, index).record, null)
})

test('withResolution leaves the index alone when there is nothing to record', () => {
  const index: DraftIndex = { [DIR]: ['Blowback.docx'] }
  assert.equal(withResolution(index, DIR, null), index)
})

test('folders are independent of each other', () => {
  const index: DraftIndex = { [DIR]: ['Blowback.docx'] }
  const other = resolveDrafts('/w/CAM_01', ['a.docx'], index)
  assert.deepEqual(other.drafts, [])
  assert.deepEqual(resolveDrafts(DIR, DOCS, index).drafts, ['Blowback.docx'])
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
  const { drafts, record } = resolveDrafts(DIR, DOCS, index)
  index = withResolution(index, DIR, record)
  assert.deepEqual(drafts, ['Blowback.docx', 'Jeremy Edit.docx'])
  assert.deepEqual(resolveDrafts(DIR, DOCS, index).drafts, drafts)
})

test('importing one document at a time accumulates, each surviving a rescan', () => {
  // "Add article" appends to whatever is already there, one file per click.
  let index = setDrafts({}, DIR, DOCS, ['Blowback.docx'])
  index = setDrafts(index, DIR, DOCS, ['Blowback.docx', 'Jeremy Edit.docx'])
  assert.deepEqual(resolveDrafts(DIR, DOCS, index).drafts, [
    'Blowback.docx',
    'Jeremy Edit.docx'
  ])
})
