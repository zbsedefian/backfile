/**
 * The project manifest: what was captured, from where, and what its bytes
 * hashed to at the moment it was captured.
 *
 * sources.csv records the journalism — which link was cited where, what has
 * been archived, what still needs doing. The manifest records the evidence: one
 * line per captured file, with a SHA-256 that lets anyone confirm months later
 * that the file in their hands is the file that was saved. It lives in the
 * project folder as plain JSON, next to sources.csv and the archive/ folder,
 * so the whole record travels as one directory the way everything else in
 * Backfile does.
 *
 * The governing rule, and the reason the code below is fussier than it looks:
 * **a recorded hash is never rewritten by a background pass.** Refreshing the
 * manifest adds entries for captures it has not seen and leaves every existing
 * one exactly as it was. If it re-hashed files, a capture altered on disk would
 * be quietly re-recorded with its new hash and verification would go on saying
 * everything is fine — which is precisely the failure this file exists to
 * prevent. Only an explicit re-capture, which is a decision a journalist made,
 * replaces an entry (and gets its own new timestamp token).
 */

import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { ServiceId, SourceLink } from '../../shared/types'
import { withLock } from '../sources/lock'

export const MANIFEST_FILENAME = 'manifest.json'

/** What produced a captured file, in words a reader outside the newsroom can use. */
export const CAPTURE_METHOD = {
  local:
    'Loaded in a headless Chromium browser (Electron) with a desktop browser user agent, ' +
    'then saved by the browser as a self-contained MHTML archive.',
  video: 'Downloaded from the page with yt-dlp.'
} as const

export type CaptureKind = keyof typeof CAPTURE_METHOD

/**
 * Which services produce a file worth hashing. archive.is and Wayback are
 * snapshots on someone else's server — there is no local file to fingerprint,
 * so they never get a manifest entry of their own.
 */
export function kindForService(service: ServiceId): CaptureKind | null {
  return service === 'local' || service === 'video' ? service : null
}

export interface ManifestTimestamp {
  /** 'opentimestamps' anchors to Bitcoin; 'rfc3161' is a signed authority token. */
  authority: 'opentimestamps' | 'rfc3161'
  /** The calendar or TSA the digest was submitted to. */
  service: string
  /** Path of the token file, relative to the project folder. */
  token: string
  /** When Backfile obtained the token. The token's own contents are the record. */
  requestedAt: string
  /** The authority's asserted time, when the scheme states one immediately. */
  assertedTime?: string
}

export interface ManifestEntry {
  /** The URL that was captured. */
  url: string
  /** The page's headline at capture time, where one could be read. */
  title: string
  /** Path of the captured file, relative to the project folder. */
  file: string
  kind: CaptureKind
  /** Prose description of how this file was produced. */
  method: string
  algorithm: 'sha256'
  /** Lowercase hex digest of the file's bytes, as captured. */
  sha256: string
  bytes: number
  /** When Backfile captured it. */
  capturedAt: string
  /** Screenshot taken alongside the capture, relative to the project folder. */
  screenshot?: string
  /** Third-party attestation of the hash above, when one was obtained. */
  timestamp?: ManifestTimestamp
  /** The version of the tool that performed the capture. */
  tool: string
}

export interface Manifest {
  manifestVersion: 1
  /** A sentence for whoever opens this file without context. */
  about: string
  /** The project folder's own name. */
  project: string
  /** When this manifest was last written. */
  generatedAt: string
  /** The tool that wrote it. */
  tool: string
  entries: ManifestEntry[]
}

const ABOUT =
  'Each entry records one archived web page or video: the URL it came from, when it was ' +
  'captured, how, and the SHA-256 digest of the captured file at that moment. To check a ' +
  'file, hash it again (e.g. `shasum -a 256 <file>`) and compare. A "timestamp" entry names ' +
  'a token from an independent timestamping service attesting that the digest existed on the ' +
  'date it states. Written by Backfile, an offline archiving tool.'

/** Manifest paths are stored with forward slashes so a project folder is portable. */
export function toPosixPath(relativePath: string): string {
  return relativePath.split(path.sep).join('/')
}

/**
 * Resolve a manifest-relative path inside the project, or null if it escapes.
 *
 * The manifest is a plain text file in a folder people edit, sync and email
 * around, so a path in it is input, not a promise. Nothing here should ever
 * read outside the project folder because a line in a JSON file said to.
 */
export function resolveInProject(projectPath: string, relativePath: string): string | null {
  const root = path.resolve(projectPath)
  const full = path.resolve(root, relativePath)
  if (full !== root && !full.startsWith(root + path.sep)) return null
  return full
}

export interface FileDigest {
  sha256: string
  bytes: number
}

/**
 * SHA-256 a file, streaming.
 *
 * Streamed rather than read whole because a downloaded video is routinely
 * hundreds of megabytes, and verification hashes every capture in the project
 * at once.
 */
export async function hashFile(filePath: string): Promise<FileDigest> {
  const hash = createHash('sha256')
  let bytes = 0
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => {
      bytes += chunk.length
      hash.update(chunk)
    })
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return { sha256: hash.digest('hex'), bytes }
}

export async function readManifest(projectPath: string): Promise<Manifest | null> {
  try {
    const text = await fs.readFile(path.join(projectPath, MANIFEST_FILENAME), 'utf8')
    const parsed = JSON.parse(text) as Manifest
    if (!Array.isArray(parsed.entries)) return null
    return parsed
  } catch {
    // A project with no manifest yet, or one whose manifest is unreadable,
    // both mean "nothing recorded" — the captures themselves are untouched.
    return null
  }
}

export async function writeManifest(projectPath: string, manifest: Manifest): Promise<void> {
  const file = path.join(projectPath, MANIFEST_FILENAME)
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    // Write-then-rename, as everywhere else here: an interrupted save must not
    // be able to truncate a record of every capture in the project.
    await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

function emptyManifest(projectPath: string, tool: string): Manifest {
  return {
    manifestVersion: 1,
    about: ABOUT,
    project: path.basename(projectPath),
    generatedAt: new Date().toISOString(),
    tool,
    entries: []
  }
}

/** Sorted by file path, so the JSON diffs cleanly in git and reads predictably. */
function sortEntries(entries: ManifestEntry[]): ManifestEntry[] {
  return [...entries].sort((a, b) => a.file.localeCompare(b.file))
}

/** Every captured file a source claims, as (path, kind) pairs. */
function capturedFilesOf(link: SourceLink): Array<{ file: string; kind: CaptureKind }> {
  const files: Array<{ file: string; kind: CaptureKind }> = []
  if (link.localPath) files.push({ file: toPosixPath(link.localPath), kind: 'local' })
  if (link.videoPath) files.push({ file: toPosixPath(link.videoPath), kind: 'video' })
  return files
}

export interface RefreshResult {
  manifest: Manifest
  /** Captures that had no entry and were hashed for the first time. */
  added: number
  /** Entries left exactly as they were, hash included. */
  unchanged: number
  /** Captures listed in sources.csv whose file is not on disk. */
  missing: number
}

/**
 * Bring the manifest up to date with the project's captures.
 *
 * Adds an entry for every capture on disk that has none. Existing entries are
 * returned verbatim — see the rule at the top of this file. An entry whose file
 * has since been deleted is *kept*, not dropped, so verification can report it
 * as missing rather than forgetting it ever existed.
 */
export async function refreshManifest(
  projectPath: string,
  links: SourceLink[],
  tool: string
): Promise<RefreshResult> {
  return withLock(`${projectPath}::manifest`, async () => {
    const existing = (await readManifest(projectPath)) ?? emptyManifest(projectPath, tool)
    const byFile = new Map(existing.entries.map((e) => [e.file, e]))

    let added = 0
    let missing = 0

    for (const link of links) {
      for (const { file, kind } of capturedFilesOf(link)) {
        if (byFile.has(file)) continue
        const full = resolveInProject(projectPath, file)
        if (!full) continue
        let digest: FileDigest
        try {
          digest = await hashFile(full)
        } catch {
          // Recorded in sources.csv but not on disk: nothing to hash, and
          // inventing an entry for it would be recording a file that is not
          // there. It shows up as a pending capture in the UI already.
          missing++
          continue
        }
        byFile.set(file, {
          url: link.url,
          title: link.title,
          file,
          kind,
          method: CAPTURE_METHOD[kind],
          algorithm: 'sha256',
          sha256: digest.sha256,
          bytes: digest.bytes,
          capturedAt: link.capturedAt || new Date().toISOString(),
          screenshot: link.screenshotPath ? toPosixPath(link.screenshotPath) : undefined,
          tool
        })
        added++
      }
    }

    const manifest: Manifest = {
      ...existing,
      manifestVersion: 1,
      about: ABOUT,
      project: path.basename(projectPath),
      generatedAt: new Date().toISOString(),
      tool,
      entries: sortEntries([...byFile.values()])
    }
    await writeManifest(projectPath, manifest)
    return { manifest, added, unchanged: existing.entries.length, missing }
  })
}

/**
 * Record a capture that has just been made, replacing any earlier entry for
 * the same file.
 *
 * This is the one path that may overwrite a recorded hash, because it only
 * runs when someone asked for the capture. The distinction from refreshing
 * matters: a re-capture is a journalist replacing a snapshot on purpose, and
 * gets a fresh hash and its own token; a file whose bytes changed without one
 * is what verification is for.
 */
export async function recordEntry(
  projectPath: string,
  entry: ManifestEntry,
  tool: string
): Promise<Manifest> {
  return withLock(`${projectPath}::manifest`, async () => {
    const existing = (await readManifest(projectPath)) ?? emptyManifest(projectPath, tool)
    const entries = existing.entries.filter((e) => e.file !== entry.file)
    entries.push(entry)
    const manifest: Manifest = {
      ...existing,
      manifestVersion: 1,
      about: ABOUT,
      project: path.basename(projectPath),
      generatedAt: new Date().toISOString(),
      tool,
      entries: sortEntries(entries)
    }
    await writeManifest(projectPath, manifest)
    return manifest
  })
}

export type VerificationStatus = 'ok' | 'modified' | 'missing' | 'unreadable'

export interface VerifiedEntry {
  file: string
  url: string
  status: VerificationStatus
  /** The digest the manifest recorded at capture time. */
  expected: string
  /** The digest of the bytes on disk now, when they could be read. */
  actual: string | null
  detail?: string
}

export interface VerificationReport {
  checkedAt: string
  /** False when the project has no manifest at all — nothing to check against. */
  manifestExists: boolean
  total: number
  ok: number
  /** Entries whose file is on disk but no longer hashes to the recorded digest. */
  modified: number
  missing: number
  unreadable: number
  entries: VerifiedEntry[]
  /** Just the entries that did not verify, in the order they were checked. */
  failures: VerifiedEntry[]
}

/**
 * Re-hash every capture the manifest records and report what no longer matches.
 *
 * Reads only files, sends nothing anywhere: verification is arithmetic on
 * bytes already on the machine, and works offline years from now with or
 * without Backfile — `shasum -a 256` against the manifest does the same job by
 * hand, which is the point of writing the digests down in plain JSON.
 */
export async function verifyManifest(projectPath: string): Promise<VerificationReport> {
  const manifest = await readManifest(projectPath)
  const checkedAt = new Date().toISOString()
  if (!manifest) {
    return {
      checkedAt,
      manifestExists: false,
      total: 0,
      ok: 0,
      modified: 0,
      missing: 0,
      unreadable: 0,
      entries: [],
      failures: []
    }
  }

  const entries: VerifiedEntry[] = []
  for (const entry of manifest.entries) {
    const full = resolveInProject(projectPath, entry.file)
    if (!full) {
      entries.push({
        file: entry.file,
        url: entry.url,
        status: 'unreadable',
        expected: entry.sha256,
        actual: null,
        detail: 'the manifest points outside the project folder'
      })
      continue
    }
    try {
      const { sha256 } = await hashFile(full)
      entries.push({
        file: entry.file,
        url: entry.url,
        status: sha256 === entry.sha256 ? 'ok' : 'modified',
        expected: entry.sha256,
        actual: sha256
      })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      entries.push({
        file: entry.file,
        url: entry.url,
        status: code === 'ENOENT' ? 'missing' : 'unreadable',
        expected: entry.sha256,
        actual: null,
        detail: err instanceof Error ? err.message : String(err)
      })
    }
  }

  const count = (status: VerificationStatus): number =>
    entries.filter((e) => e.status === status).length

  return {
    checkedAt,
    manifestExists: true,
    total: entries.length,
    ok: count('ok'),
    modified: count('modified'),
    missing: count('missing'),
    unreadable: count('unreadable'),
    entries,
    failures: entries.filter((e) => e.status !== 'ok')
  }
}

/** One line a person can read, for the status bar and the report. */
export function summarizeVerification(report: VerificationReport): string {
  if (!report.manifestExists) {
    return 'No manifest yet — capture something, or choose Evidence › Update Manifest.'
  }
  if (report.total === 0) return 'The manifest records no captures yet.'
  if (report.failures.length === 0) {
    return `All ${report.total} capture${report.total === 1 ? '' : 's'} match the manifest.`
  }
  const parts: string[] = []
  if (report.modified) parts.push(`${report.modified} modified`)
  if (report.missing) parts.push(`${report.missing} missing`)
  if (report.unreadable) parts.push(`${report.unreadable} unreadable`)
  return `${report.ok}/${report.total} verified — ${parts.join(', ')}.`
}
