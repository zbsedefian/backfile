import test from 'node:test'
import assert from 'node:assert/strict'
import { isInsideFolder } from '../src/main/project/scan'

test('a file directly in the folder is inside it', () => {
  assert.equal(isInsideFolder('/w/CAM_02/Blowback.docx', '/w/CAM_02'), true)
})

test('a file in a sibling folder is not inside it', () => {
  assert.equal(isInsideFolder('/w/CAM_03/Other.docx', '/w/CAM_02'), false)
})

test('a file in a subfolder does not count — scanning is not recursive either', () => {
  assert.equal(isInsideFolder('/w/CAM_02/images/photo.jpg', '/w/CAM_02'), false)
})

test('a file in the parent of the folder is not inside it', () => {
  assert.equal(isInsideFolder('/w/Other.docx', '/w/CAM_02'), false)
})

test('a trailing slash on the folder does not change the answer', () => {
  assert.equal(isInsideFolder('/w/CAM_02/Blowback.docx', '/w/CAM_02/'), true)
})

test('a folder name that is a prefix of another is not confused with it', () => {
  // /w/CAM_02-old is not inside /w/CAM_02, despite sharing a string prefix.
  assert.equal(isInsideFolder('/w/CAM_02-old/Blowback.docx', '/w/CAM_02'), false)
})
