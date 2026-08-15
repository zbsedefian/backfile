import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_SELECTION,
  applyArrow,
  applyClick,
  reconcile,
  selectAll,
  selectOne,
  type Selection
} from '../src/shared/selection'

const LIST = ['a', 'b', 'c', 'd', 'e']

const plain = { toggle: false, range: false }
const cmd = { toggle: true, range: false }
const shift = { toggle: false, range: true }

test('a plain click replaces the selection', () => {
  const start: Selection = { urls: ['a', 'b'], focus: 'b', anchor: 'a' }
  assert.deepEqual(applyClick(LIST, start, 'd', plain), selectOne('d'))
})

test('cmd-click adds a row without disturbing the rest', () => {
  const next = applyClick(LIST, selectOne('b'), 'd', cmd)
  assert.deepEqual(next.urls, ['b', 'd'])
  assert.equal(next.focus, 'd')
})

test('cmd-clicking a selected row deselects it', () => {
  const start: Selection = { urls: ['b', 'c', 'd'], focus: 'd', anchor: 'b' }
  const next = applyClick(LIST, start, 'c', cmd)
  assert.deepEqual(next.urls, ['b', 'd'])
})

test('deselecting the focused row moves focus to what is left', () => {
  const start: Selection = { urls: ['b', 'd'], focus: 'd', anchor: 'b' }
  const next = applyClick(LIST, start, 'd', cmd)
  assert.deepEqual(next.urls, ['b'])
  assert.equal(next.focus, 'b')
})

test('deselecting the only row leaves no focus', () => {
  const next = applyClick(LIST, selectOne('c'), 'c', cmd)
  assert.deepEqual(next.urls, [])
  assert.equal(next.focus, null)
})

test('selection stays in list order however it was built', () => {
  let sel = selectOne('e')
  sel = applyClick(LIST, sel, 'b', cmd)
  sel = applyClick(LIST, sel, 'c', cmd)
  assert.deepEqual(sel.urls, ['b', 'c', 'e'])
})

test('shift-click takes the span from the anchor', () => {
  const next = applyClick(LIST, selectOne('b'), 'd', shift)
  assert.deepEqual(next.urls, ['b', 'c', 'd'])
  assert.equal(next.anchor, 'b')
  assert.equal(next.focus, 'd')
})

test('shift-click works upwards too', () => {
  const next = applyClick(LIST, selectOne('d'), 'b', shift)
  assert.deepEqual(next.urls, ['b', 'c', 'd'])
})

test('a second shift-click re-measures from the anchor rather than growing', () => {
  const wide = applyClick(LIST, selectOne('b'), 'e', shift)
  assert.deepEqual(wide.urls, ['b', 'c', 'd', 'e'])
  const narrow = applyClick(LIST, wide, 'c', shift)
  assert.deepEqual(narrow.urls, ['b', 'c'])
})

test('shift-click with a stale anchor falls back to a plain click', () => {
  const stale: Selection = { urls: [], focus: null, anchor: 'gone' }
  assert.deepEqual(applyClick(LIST, stale, 'c', shift), selectOne('c'))
})

test('shift-click with no anchor at all falls back to a plain click', () => {
  assert.deepEqual(applyClick(LIST, EMPTY_SELECTION, 'c', shift), selectOne('c'))
})

test('a bare arrow moves and collapses to one row', () => {
  const start: Selection = { urls: ['a', 'b', 'c'], focus: 'c', anchor: 'a' }
  assert.deepEqual(applyArrow(LIST, start, 1, false), selectOne('d'))
})

test('shift-arrow extends from the anchor', () => {
  const sel = applyArrow(LIST, selectOne('b'), 1, true)
  assert.deepEqual(sel.urls, ['b', 'c'])
  const wider = applyArrow(LIST, sel, 1, true)
  assert.deepEqual(wider.urls, ['b', 'c', 'd'])
})

test('shift-arrow back over the anchor shrinks the range', () => {
  let sel = applyArrow(LIST, selectOne('b'), 1, true)
  sel = applyArrow(LIST, sel, 1, true)
  assert.deepEqual(sel.urls, ['b', 'c', 'd'])
  sel = applyArrow(LIST, sel, -1, true)
  assert.deepEqual(sel.urls, ['b', 'c'])
})

test('arrows stop at the ends instead of wrapping', () => {
  assert.deepEqual(applyArrow(LIST, selectOne('e'), 1, false), selectOne('e'))
  assert.deepEqual(applyArrow(LIST, selectOne('a'), -1, false), selectOne('a'))
})

test('from nothing, down starts at the top and up at the bottom', () => {
  assert.deepEqual(applyArrow(LIST, EMPTY_SELECTION, 1, false), selectOne('a'))
  assert.deepEqual(applyArrow(LIST, EMPTY_SELECTION, -1, false), selectOne('e'))
})

test('arrows on an empty list select nothing', () => {
  assert.deepEqual(applyArrow([], selectOne('a'), 1, false), EMPTY_SELECTION)
})

test('select all takes every row', () => {
  assert.deepEqual(selectAll(LIST).urls, LIST)
  assert.deepEqual(selectAll([]), EMPTY_SELECTION)
})

test('reconcile drops rows the list no longer has', () => {
  const start: Selection = { urls: ['a', 'c', 'e'], focus: 'c', anchor: 'a' }
  const next = reconcile(['a', 'b', 'c'], start)
  assert.deepEqual(next.urls, ['a', 'c'])
  assert.equal(next.focus, 'c')
})

test('reconcile rehomes focus and anchor when their rows are gone', () => {
  const start: Selection = { urls: ['a', 'e'], focus: 'e', anchor: 'e' }
  const next = reconcile(['a', 'b'], start)
  assert.deepEqual(next.urls, ['a'])
  assert.equal(next.focus, 'a')
  assert.equal(next.anchor, 'a')
})

test('reconcile returns the same object when nothing was lost', () => {
  const start: Selection = { urls: ['a', 'b'], focus: 'b', anchor: 'a' }
  assert.equal(reconcile(LIST, start), start)
})

test('reconcile leaves an empty selection alone', () => {
  assert.equal(reconcile(LIST, EMPTY_SELECTION), EMPTY_SELECTION)
})
