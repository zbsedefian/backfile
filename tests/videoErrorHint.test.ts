/**
 * The hint appended to a video-download failure, covering the three distinct
 * cases this was built against:
 *
 * - "unable to download video data: HTTP Error 403: Forbidden" for a plain
 *   youtube.com/watch URL — a stale yt-dlp.
 * - "[youtube] cZR9PaQkj2M: Sign in to confirm your age. ... Use
 *   --cookies-from-browser or --cookies for the authentication." — an
 *   age-gated video that no yt-dlp update can fix, only a signed-in session.
 * - Video Cookies turned on, but macOS refusing yt-dlp access to the
 *   browser's own cookie database — a permission wall, not a real failure.
 *
 * All three must stay distinct: the advice for one is wrong for the others.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { withUpdateHint } from '../src/main/capture/video'

test('a 403 gets the update hint appended', () => {
  const message = withUpdateHint('ERROR: unable to download video data: HTTP Error 403: Forbidden')
  assert.match(message, /HTTP Error 403: Forbidden/)
  assert.match(message, /yt-dlp is out of date/i)
  assert.match(message, /yt-dlp -U/)
})

test('"confirm you\'re not a bot" gets the update hint too', () => {
  const message = withUpdateHint('ERROR: Sign in to confirm you’re not a bot')
  assert.match(message, /out of date/i)
})

test('an age gate that suggests --cookies-from-browser gets the sign-in hint, not the update hint', () => {
  const message = withUpdateHint(
    'ERROR: [youtube] cZR9PaQkj2M: Sign in to confirm your age. This video may ' +
      'be inappropriate for some users. Use --cookies-from-browser or --cookies ' +
      'for the authentication. See ' +
      'https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp ' +
      'for how to manually pass cookies.'
  )
  assert.match(message, /Video Cookies/)
  assert.match(message, /signed-in YouTube session/i)
  assert.doesNotMatch(message, /out of date/i)
})

test('Safari cookie access denied points at Full Disk Access', () => {
  const message = withUpdateHint(
    'ERROR: Could not copy Safari cookie database. Permission denied.',
    'safari'
  )
  assert.match(message, /Full Disk Access/)
  assert.match(message, /Privacy & Security/)
  assert.doesNotMatch(message, /out of date/i)
  assert.doesNotMatch(message, /Video Cookies/)
})

test('Chrome cookie access denied points at Keychain Access, not Full Disk Access', () => {
  const message = withUpdateHint('ERROR: Failed to decrypt cookie — keychain access denied', 'chrome')
  assert.match(message, /Keychain Access/)
  assert.match(message, /Safe Storage/)
  assert.doesNotMatch(message, /Full Disk Access/)
})

test('the same message with cookies off is not mistaken for a permission wall', () => {
  // Without a cookiesBrowser, "keychain" in a message has no video-cookies
  // context to explain it, so it falls through rather than guessing.
  const message = withUpdateHint('ERROR: Failed to decrypt cookie — keychain access denied', null)
  assert.doesNotMatch(message, /Keychain Access|Full Disk Access/)
})

test('an age gate is still recognised correctly when cookies are already on', () => {
  // A genuine sign-in requirement, not a permission problem — the cookie
  // database WAS read successfully, the video just needs a login it lacks.
  const message = withUpdateHint(
    'ERROR: Sign in to confirm your age. Use --cookies-from-browser or --cookies for the authentication.',
    'chrome'
  )
  assert.match(message, /Video Cookies/)
  assert.doesNotMatch(message, /Keychain Access|Full Disk Access/)
})

test('an unrelated failure is left exactly as yt-dlp reported it', () => {
  const message = 'ERROR: [youtube] abc123: Video unavailable. This video is private'
  assert.equal(withUpdateHint(message), message)
})

test('a plain network timeout is not treated as a blocking error', () => {
  const message = 'ERROR: unable to download video data: <urlopen error timed out>'
  assert.equal(withUpdateHint(message), message)
})

test('the original message is never dropped, only extended', () => {
  const original = 'ERROR: unable to download video data: HTTP Error 403: Forbidden'
  assert.ok(withUpdateHint(original).startsWith(original))
})
