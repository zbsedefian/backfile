import test from 'node:test'
import assert from 'node:assert/strict'
import { assetName, installFileName } from '../src/main/capture/ytdlpInstall'

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

test('macOS downloads the universal binary and installs it as a plain "yt-dlp"', () => {
  assert.equal(withPlatform('darwin', assetName), 'yt-dlp_macos')
  assert.equal(withPlatform('darwin', installFileName), 'yt-dlp')
})

test('Windows gets a ".exe" — a bare binary with no extension will not run there', () => {
  assert.equal(withPlatform('win32', assetName), 'yt-dlp.exe')
  assert.equal(withPlatform('win32', installFileName), 'yt-dlp.exe')
})

test('Linux downloads the self-contained binary, needing no system Python', () => {
  assert.equal(withPlatform('linux', assetName), 'yt-dlp_linux')
  assert.equal(withPlatform('linux', installFileName), 'yt-dlp')
})

test('a platform with no published yt-dlp binary is reported as null, not a guess', () => {
  assert.equal(withPlatform('freebsd', assetName), null)
  assert.equal(withPlatform('freebsd', installFileName), null)
})
