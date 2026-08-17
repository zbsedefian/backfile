/**
 * Tie the report template, the manifest, and PDF rendering together into the
 * one action a journalist actually takes: "give me the piece of paper for
 * this source."
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readSources } from '../sources/csv'
import { buildReportHtml, reportFilename } from './report'
import { refreshManifest, resolveInProject, toPosixPath, verifyManifest } from './manifest'
import { renderHtmlToPdf } from './pdf'

/** Captures live in archive/, so reports do too — the whole project is one folder. */
export const REPORTS_DIRNAME = path.join('archive', 'reports')

async function screenshotDataUrl(articlePath: string, relativePath: string): Promise<string | null> {
  const full = resolveInProject(articlePath, relativePath)
  if (!full) return null
  try {
    const buffer = await fs.readFile(full)
    return `data:image/png;base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

export interface GenerateReportResult {
  path: string
  /** Relative to the project folder, for the UI to show or reveal. */
  relativePath: string
}

/**
 * Build and write a capture report for one source.
 *
 * Includes a fresh verification of that source's own captured files, not the
 * last one on record — a report generated to attach to a filing should reflect
 * the files as they are right now, not as they were the last time someone
 * happened to run Evidence › Verify Captures.
 */
export async function generateCaptureReport(
  articlePath: string,
  url: string,
  tool: string
): Promise<GenerateReportResult> {
  const sources = await readSources(articlePath)
  const link = sources.find((l) => l.url === url)
  if (!link) throw new Error('that source is no longer in this project')

  // A capture made before this source ever had a manifest entry — from before
  // the manifest existed, or from a project someone just pointed Backfile at
  // — still deserves a report. Scoped to this one source so generating a
  // report never re-hashes the whole project's worth of video files.
  const { manifest } = await refreshManifest(articlePath, [link], tool)
  const files = new Set(
    [link.localPath, link.videoPath].filter(Boolean).map((p) => toPosixPath(p))
  )
  const entries = manifest.entries.filter((e) => files.has(e.file))

  const fullVerification = entries.length > 0 ? await verifyManifest(articlePath) : null
  const verification = fullVerification?.entries.filter((e) => files.has(e.file)) ?? []

  const screenshot = link.screenshotPath
    ? await screenshotDataUrl(articlePath, link.screenshotPath)
    : null

  const html = buildReportHtml({
    project: path.basename(articlePath),
    url: link.url,
    title: link.title,
    anchorText: link.anchorText || undefined,
    foundIn: link.foundIn,
    archiveIs: link.archiveIs || undefined,
    wayback: link.wayback || undefined,
    notes: link.notes || undefined,
    entries,
    verification,
    screenshotDataUrl: screenshot,
    generatedAt: new Date().toISOString(),
    tool
  })

  const pdf = await renderHtmlToPdf(html)

  const dir = path.join(articlePath, REPORTS_DIRNAME)
  await fs.mkdir(dir, { recursive: true })
  const filename = reportFilename(link.url, entries)
  const destination = path.join(dir, filename)
  await fs.writeFile(destination, pdf)

  return { path: destination, relativePath: toPosixPath(path.join(REPORTS_DIRNAME, filename)) }
}
