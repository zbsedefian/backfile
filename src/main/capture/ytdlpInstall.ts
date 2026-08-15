/**
 * Fetching yt-dlp's own prebuilt binary, for the journalist who has never
 * opened a terminal.
 *
 * "brew install yt-dlp" is a fine instruction for the technical minority and
 * an immediate dead end for everyone else — the exact audience this app is
 * for. yt-dlp itself publishes a self-contained binary per platform on every
 * release, so this downloads that one file straight from GitHub into
 * Backfile's own folder, rather than reaching for a package manager the
 * journalist may not have. It is still not bundled and not pinned (see the
 * header on video.ts for why) — this only runs when the journalist clicks
 * the button, same as brew install would have needed them to type a command.
 */

import { app } from 'electron'
import { createWriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
const NO_PREBUILT =
  'No prebuilt yt-dlp is published for this platform. Install it yourself: ' +
  'https://github.com/yt-dlp/yt-dlp/wiki/Installation'

/**
 * The release asset for this OS, and the filename it is installed under.
 *
 * Pure functions of process.platform, kept apart from ytdlpInstallDir below
 * so they can be tested without an Electron process to call app.getPath in —
 * the platform-naming logic is the part actually worth locking down; where
 * userData happens to live is Electron's own concern, not this file's.
 */
export function assetName(): string | null {
  if (process.platform === 'darwin') return 'yt-dlp_macos' // universal: arm64 + x64
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'linux') return 'yt-dlp_linux' // no system Python required
  return null
}

export function installFileName(): string | null {
  if (!assetName()) return null
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
}

export function ytdlpInstallDir(): string {
  return path.join(app.getPath('userData'), 'bin')
}

/** Where an install lands, and where findYtDlp looks for one already there. */
export function ytdlpInstallPath(): string | null {
  const name = installFileName()
  if (!name) return null
  return path.join(ytdlpInstallDir(), name)
}

export interface InstallProgress {
  receivedBytes: number
  /** null when the server does not report a size, which yt-dlp's GitHub releases always do in practice. */
  totalBytes: number | null
}

/** Downloads yt-dlp's own binary and confirms it actually runs before calling it installed. */
export async function installYtDlp(onProgress?: (p: InstallProgress) => void): Promise<string> {
  const asset = assetName()
  const target = ytdlpInstallPath()
  if (!asset || !target) throw new Error(NO_PREBUILT)

  const url = `${RELEASE_BASE}/${asset}`
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(
      `Could not reach GitHub to download yt-dlp (HTTP ${response.status}). Check your ` +
        'connection and try again.'
    )
  }

  const totalBytes = Number(response.headers.get('content-length')) || null
  let receivedBytes = 0

  await fs.mkdir(ytdlpInstallDir(), { recursive: true })
  // Downloaded under a temp name and renamed into place, so a connection drop
  // mid-download can never leave a half-written file where findYtDlp would
  // find and try to run it.
  const tmp = `${target}.download`

  try {
    const out = createWriteStream(tmp)
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      receivedBytes += value.byteLength
      onProgress?.({ receivedBytes, totalBytes })
      if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', resolve))
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err instanceof Error ? err : new Error(String(err))
  }

  if (process.platform !== 'win32') await fs.chmod(tmp, 0o755)
  await fs.rename(tmp, target)

  // A corrupted download, or GitHub serving an HTML error page instead of the
  // binary, would otherwise look installed right up until the first real
  // capture failed on it in a way nobody could explain.
  try {
    await run(target, ['--version'], { timeout: 10_000 })
  } catch {
    await fs.rm(target, { force: true }).catch(() => undefined)
    throw new Error(
      'The download did not run as yt-dlp. This can happen on a flaky connection — try again.'
    )
  }

  return target
}
