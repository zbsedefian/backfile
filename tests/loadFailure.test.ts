/**
 * Which 'did-fail-load' events actually mean a capture failed.
 *
 * Reproduced against a real page (kyivpost.com/post/27383): the article body
 * loads fine while a FreeWheel ad-sync iframe buried in the page loops into
 * ERR_TOO_MANY_REDIRECTS in the background. Before this fix, that sub-frame
 * failure was treated as fatal and the capture failed on an article that any
 * reader's own browser renders without complaint.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { isRealLoadFailure } from '../src/main/capture/local'

test('a sub-frame failure is not a real failure, whatever the error code', () => {
  // The exact case reproduced against kyivpost.com.
  assert.equal(isRealLoadFailure(-310, false), false)
  assert.equal(isRealLoadFailure(-105, false), false)
  assert.equal(isRealLoadFailure(-3, false), false)
})

test('a main-frame failure is real, unless it is ERR_ABORTED', () => {
  assert.equal(isRealLoadFailure(-105, true), true) // ERR_NAME_NOT_RESOLVED
  assert.equal(isRealLoadFailure(-2, true), true) // ERR_FAILED
  assert.equal(isRealLoadFailure(-310, true), true) // the main frame itself looping
})

test('ERR_ABORTED on the main frame is not a failure', () => {
  // Fires on ordinary redirects; the main frame still ends up loaded.
  assert.equal(isRealLoadFailure(-3, true), false)
})
