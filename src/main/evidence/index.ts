/**
 * The evidence step that runs after a capture succeeds: hash the file, ask a
 * timestamping service to attest the hash, store the token beside the capture,
 * and write it all into the project manifest.
 *
 * Kept apart from the capture adapters on purpose. An adapter's job is to get
 * the page; whether the newsroom wants a third-party attestation of it is a
 * separate policy question, and one that should not be able to fail a capture.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  CAPTURE_METHOD,
  CaptureKind,
  hashFile,
  ManifestEntry,
  recordEntry,
  resolveInProject,
  toPosixPath
} from './manifest'
import { requestTimestamp, TimestampSettings, tokenFilenameFor } from './timestamp'

export interface AttestRequest {
  projectPath: string
  url: string
  title?: string
  /** The capture's path relative to the project folder, as sources.csv stores it. */
  relativePath: string
  kind: CaptureKind
  screenshotPath?: string
  /** Defaults to now. */
  capturedAt?: string
  /** Version string recorded against the entry, e.g. "Backfile 0.1.0". */
  tool: string
  timestamping: TimestampSettings
  signal?: AbortSignal
}

export interface AttestResult {
  entry: ManifestEntry | null
  /**
   * Set when the capture was recorded but something optional did not work —
   * a calendar server being down, say. Shown to the journalist, never thrown:
   * the archive is the thing that matters, and it is already saved.
   */
  warning?: string
}

/**
 * Record a freshly-made capture as evidence.
 *
 * Failure here is deliberately soft. A capture that succeeded is a page
 * preserved, and losing it because a timestamp authority was unreachable would
 * be the wrong trade — the manifest entry is still written, just without a
 * token, and re-running the timestamp later is a matter of re-capturing or
 * turning the setting on and capturing the next one.
 */
export async function attestCapture(request: AttestRequest): Promise<AttestResult> {
  const {
    projectPath,
    url,
    title = '',
    relativePath,
    kind,
    screenshotPath,
    capturedAt,
    tool,
    timestamping,
    signal
  } = request

  const file = toPosixPath(relativePath)
  const full = resolveInProject(projectPath, file)
  if (!full) return { entry: null, warning: `${file} is outside the project folder` }

  let digest
  try {
    digest = await hashFile(full)
  } catch (err) {
    return {
      entry: null,
      warning: `could not hash ${file}: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  const entry: ManifestEntry = {
    url,
    title,
    file,
    kind,
    method: CAPTURE_METHOD[kind],
    algorithm: 'sha256',
    sha256: digest.sha256,
    bytes: digest.bytes,
    capturedAt: capturedAt || new Date().toISOString(),
    screenshot: screenshotPath ? toPosixPath(screenshotPath) : undefined,
    tool
  }

  let warning: string | undefined
  try {
    const token = await requestTimestamp(Buffer.from(digest.sha256, 'hex'), timestamping, signal)
    if (token) {
      // Beside the capture it attests, inside archive/ — the whole project
      // folder is meant to be handed over as one thing.
      const tokenRelative = toPosixPath(
        tokenFilenameFor(relativePath, token.extension)
      )
      const tokenFull = resolveInProject(projectPath, tokenRelative)
      if (tokenFull) {
        await fs.mkdir(path.dirname(tokenFull), { recursive: true })
        await fs.writeFile(tokenFull, token.bytes)
        entry.timestamp = {
          authority: token.authority,
          service: token.url,
          token: tokenRelative,
          requestedAt: new Date().toISOString(),
          assertedTime: token.assertedTime
        }
      }
    }
  } catch (err) {
    warning = `capture saved, but timestamping failed: ${
      err instanceof Error ? err.message : String(err)
    }`
  }

  await recordEntry(projectPath, entry, tool)
  return { entry, warning }
}

export {
  kindForService,
  MANIFEST_FILENAME,
  refreshManifest,
  readManifest,
  summarizeVerification,
  verifyManifest
} from './manifest'
export type {
  CaptureKind,
  Manifest,
  ManifestEntry,
  ManifestTimestamp,
  VerificationReport,
  VerifiedEntry
} from './manifest'
export { DEFAULT_TIMESTAMP_SETTINGS, DEFAULT_TSA_URL, verificationCommandFor } from './timestamp'
export type { TimestampMode, TimestampSettings } from './timestamp'
export { generateCaptureReport } from './generateReport'
export type { GenerateReportResult } from './generateReport'
