/**
 * Video capture, via yt-dlp.
 *
 * An MHTML capture of a YouTube page keeps the title, channel and description
 * and a player that will never play — the video is streamed through separate
 * requests that are not part of the page. For a journalist citing footage, the
 * footage is the evidence and everything else is context, so without this the
 * most important sources in a story are the ones least preserved.
 *
 * yt-dlp is not bundled. It is a fast-moving tool that breaks whenever sites
 * change, so pinning a copy inside the app would ship something permanently
 * out of date; and downloading from some of these sites is against their terms
 * of service, which is a decision for the journalist rather than for us. If it
 * is not installed, this says so plainly instead of failing obscurely.
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { CaptureAdapter, CaptureContext, fail, ok } from './types'
import { CaptureResult } from '../../shared/types'
import { CAPTURE_DIRNAME } from './local'

const run = promisify(execFile)

/** Where a downloaded video lands, beside the page captures. */
const VIDEO_DIRNAME = path.join(CAPTURE_DIRNAME, 'video')

const DOWNLOAD_TIMEOUT_MS = 20 * 60_000
/** Cap the size so one four-hour livestream cannot silently fill a disk. */
const MAX_FILESIZE = '2G'

export const YTDLP_MISSING =
  'yt-dlp is not installed. Install it with "brew install yt-dlp" (macOS) or ' +
  '"pipx install yt-dlp", then try again.'

let cachedPath: string | null | undefined

/** Find yt-dlp once per session, checking the usual places a GUI app misses. */
export async function findYtDlp(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath

  const candidates = [
    'yt-dlp',
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    path.join(process.env.HOME ?? '', '.local/bin/yt-dlp')
  ]

  for (const candidate of candidates) {
    try {
      // A launched .app does not inherit the shell's PATH, so "yt-dlp" alone
      // frequently fails for a user who can run it fine in their terminal.
      await run(candidate, ['--version'], { timeout: 10_000 })
      cachedPath = candidate
      return candidate
    } catch {
      continue
    }
  }
  cachedPath = null
  return null
}

/** Forget the cached lookup, so installing yt-dlp does not require a restart. */
export function resetYtDlpCache(): void {
  cachedPath = undefined
}

export const videoAdapter: CaptureAdapter = {
  id: 'video',
  label: 'Video',
  requiresHuman: false,

  async capture(url: string, ctx: CaptureContext): Promise<CaptureResult> {
    const binary = await findYtDlp()
    if (!binary) return fail('video', url, YTDLP_MISSING)

    const dir = path.join(ctx.articlePath, VIDEO_DIRNAME)
    await fs.mkdir(dir, { recursive: true })

    // %(id)s keeps the name unique and stable, so re-downloading replaces the
    // same file rather than accumulating "video (1).mp4" forever.
    const template = path.join(dir, '%(title).80s [%(id)s].%(ext)s')

    try {
      const { stdout } = await run(
        binary,
        [
          url,
          '--no-playlist',
          '--no-progress',
          '--restrict-filenames',
          '--max-filesize',
          MAX_FILESIZE,
          // Write the metadata alongside: titles and descriptions get edited
          // or deleted, and the .info.json is often the citable detail.
          '--write-info-json',
          '--write-thumbnail',
          '--merge-output-format',
          'mp4',
          '-o',
          template,
          '--print',
          'after_move:filepath'
        ],
        { timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
      )

      const produced = stdout.trim().split('\n').filter(Boolean).pop()
      if (!produced) {
        return fail('video', url, 'yt-dlp produced no file (the video may be unavailable)')
      }

      // Store relative, like every other capture, so the folder stays portable.
      return ok('video', url, path.relative(ctx.articlePath, produced))
    } catch (err) {
      const anyErr = err as { stderr?: string; killed?: boolean; message?: string }
      if (anyErr.killed) return fail('video', url, 'timed out')
      // yt-dlp's last stderr line is almost always the actionable one.
      const stderr = (anyErr.stderr ?? '').trim().split('\n').filter(Boolean).pop()
      return fail('video', url, stderr || anyErr.message || 'yt-dlp failed')
    }
  }
}
