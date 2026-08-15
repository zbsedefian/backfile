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
import { ytdlpInstallPath } from './ytdlpInstall'

const run = promisify(execFile)

/** Where a downloaded video lands, beside the page captures. */
const VIDEO_DIRNAME = path.join(CAPTURE_DIRNAME, 'video')

const DOWNLOAD_TIMEOUT_MS = 20 * 60_000
/** Cap the size so one four-hour livestream cannot silently fill a disk. */
const MAX_FILESIZE = '2G'

/**
 * Prefer H.264 video with AAC audio.
 *
 * Left to itself yt-dlp picks the best available stream, which on YouTube now
 * means AV1 and Opus. That produces a technically superior file that QuickTime,
 * Preview and most editing software cannot decode — the video is there, it just
 * shows nothing. An archive that will not open is not an archive, so
 * compatibility wins over codec efficiency here, with progressive fallbacks so
 * an unusual source still downloads something rather than failing.
 */
const FORMAT =
  'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/' +
  'bv*[ext=mp4]+ba[ext=m4a]/' +
  'b[ext=mp4]/' +
  'bv*+ba/b'

export const YTDLP_MISSING =
  'yt-dlp is not installed. Use "Install yt-dlp" under Capture all… › Videos, ' +
  'or install it yourself with "brew install yt-dlp" (macOS) or "pipx install yt-dlp".'

/**
 * Three distinct failures get an actionable line appended, checked in this
 * order because each one rules out the next — giving two pieces of advice at
 * once on the same error is worse than picking wrong, since it leaves the
 * journalist to guess which one is real.
 *
 * A cookie-access failure means Video Cookies is turned on but the OS itself
 * is refusing to hand the browser's cookie database to yt-dlp — a macOS
 * permission wall, not anything wrong with the video, the network, or
 * yt-dlp's own code. Checked first because its signature ("cookie",
 * "keychain", "permission") can otherwise look like the sign-in-required case
 * below, and the fix is completely different: no browser is even being read.
 *
 * An age-gated or sign-in-required video is not a bug in yt-dlp either: the
 * video genuinely requires being logged in to watch, and yt-dlp already says
 * so directly (it is the one that suggests --cookies-from-browser in its own
 * error text, which is the most reliable way to recognise this case — more
 * durable than matching yt-dlp's human-readable wording, which changes).
 * Updating yt-dlp will not fix this.
 *
 * Everything else that looks like a 403 or a "confirm you're not a bot" wall
 * is, by contrast, overwhelmingly a stale yt-dlp: YouTube changes its player
 * often enough that this is closer to routine than exceptional, and yt-dlp
 * ships a fix just as often — which is also why it is not bundled with
 * Backfile (see the file header). Cookies will not fix this one.
 */
export function withUpdateHint(message: string, cookiesBrowser?: string | null): string {
  if (
    cookiesBrowser &&
    /keychain|cookie.{0,20}(database|permission|denied|access)|could not (find|copy|load).{0,20}cooki/i.test(
      message
    )
  ) {
    return cookiesBrowser === 'safari'
      ? `${message} — macOS is blocking access to Safari's cookies. Grant Backfile Full ` +
          'Disk Access: System Settings › Privacy & Security › Full Disk Access, then try again.'
      : `${message} — macOS is blocking access to ${cookiesBrowser}'s saved cookies, ` +
          `likely a Keychain prompt that needs approving. Try again — if it keeps failing, ` +
          `open Keychain Access and unlock ${cookiesBrowser}'s "Safe Storage" item.`
  }
  if (/cookies-from-browser|--cookies\b/i.test(message)) {
    return (
      `${message} — this video needs a signed-in YouTube session to watch. ` +
      'Backfile can pass your own browser’s login to yt-dlp for exactly ' +
      'this: turn it on under Capture › Video Cookies, then try again.'
    )
  }
  if (/\b403\b|forbidden|confirm you.?re not a bot|not a bot/i.test(message)) {
    return (
      `${message} — this usually means yt-dlp is out of date. YouTube changes ` +
      'often and yt-dlp ships a fix just as often; update it ("yt-dlp -U", or ' +
      '"brew upgrade yt-dlp" on macOS) and try again.'
    )
  }
  return message
}

let cachedPath: string | null | undefined

/** Find yt-dlp once per session, checking the usual places a GUI app misses. */
export async function findYtDlp(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath

  const installed = ytdlpInstallPath()
  const candidates = [
    'yt-dlp',
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    path.join(process.env.HOME ?? '', '.local/bin/yt-dlp'),
    // Where "Install yt-dlp" in the app itself puts it — checked last so a
    // real system install, likely kept newer by the journalist's own package
    // manager, still wins when both exist.
    ...(installed ? [installed] : [])
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
          '-f',
          FORMAT,
          '--max-filesize',
          MAX_FILESIZE,
          // Write the metadata alongside: titles and descriptions get edited
          // or deleted, and the .info.json is often the citable detail.
          '--write-info-json',
          '--write-thumbnail',
          '--merge-output-format',
          'mp4',
          // Filenames are derived from the video id, so without this yt-dlp
          // sees the existing file and skips — meaning a re-capture to replace
          // a bad download would silently do nothing.
          '--force-overwrites',
          // Opt-in only (see Settings.videoCookiesBrowser): an age-gated or
          // sign-in-required video cannot be fetched anonymously at all, and
          // this is the one thing Backfile does that touches a real, logged-in
          // browser session rather than making a plain anonymous request.
          ...(ctx.cookiesBrowser ? ['--cookies-from-browser', ctx.cookiesBrowser] : []),
          '-o',
          template,
          '--print',
          'after_move:filepath'
        ],
        { timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, signal: ctx.signal }
      )

      const produced = stdout.trim().split('\n').filter(Boolean).pop()
      if (!produced) {
        return fail('video', url, 'yt-dlp produced no file (the video may be unavailable)')
      }

      // Store relative, like every other capture, so the folder stays portable.
      return ok('video', url, path.relative(ctx.articlePath, produced))
    } catch (err) {
      const anyErr = err as { stderr?: string; killed?: boolean; message?: string }
      // An aborted download leaves a .part file behind; yt-dlp cleans it up on
      // the next attempt, but the failure must not be reported as a timeout.
      if (ctx.signal?.aborted) return fail('video', url, 'cancelled')
      if (anyErr.killed) return fail('video', url, 'timed out')
      // yt-dlp's last stderr line is almost always the actionable one — but it
      // also prints an update notice on every run, which would otherwise be
      // reported to the journalist as the reason their download failed.
      const stderr = (anyErr.stderr ?? '')
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !/^WARNING:|update|pip|wheel|PyPi/i.test(line))
        .pop()
      return fail(
        'video',
        url,
        withUpdateHint(stderr || anyErr.message || 'yt-dlp failed', ctx.cookiesBrowser)
      )
    }
  }
}
