/**
 * The capture report: one printable page per source, for attaching to a filing.
 *
 * Everything else in Backfile is written for the journalist who made the
 * archive. This is written for the stranger who receives it — a clerk, an
 * opposing counsel, a fact-checker — who has never heard of this tool and has
 * no reason to take its word for anything. So the report states what was
 * captured, when, by what method, and what it hashed to, and then explains how
 * to check every one of those claims with software the reader already has.
 *
 * Pure string-building, kept apart from the printing so the wording can be read
 * and tested without an Electron window in the loop.
 */

import { ManifestEntry, VerifiedEntry } from './manifest'
import { verificationCommandFor } from './timestamp'

export interface ReportInput {
  /** The project folder's name. */
  project: string
  url: string
  title: string
  /** The text the link sat behind in the article, if any. */
  anchorText?: string
  /** Documents that cite this source. */
  foundIn?: string[]
  archiveIs?: string
  wayback?: string
  notes?: string
  /** The captured files for this source, from the manifest. */
  entries: ManifestEntry[]
  /** Re-hash results at the time the report was made, keyed by file. */
  verification?: VerifiedEntry[]
  /** The capture screenshot as a data: URL, so the PDF stands alone. */
  screenshotDataUrl?: string | null
  /** ISO instant the report was generated. */
  generatedAt: string
  tool: string
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** ISO instants are exact but unreadable; a filing wants both. */
function humanTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.toUTCString().replace('GMT', 'UTC')} (${date.toISOString()})`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]} (${bytes.toLocaleString('en-US')} bytes)`
}

/** The hash split into readable groups — nobody proofreads 64 unbroken characters. */
function groupHash(hash: string): string {
  return (hash.match(/.{1,8}/g) ?? [hash]).join(' ')
}

const STATUS_WORDING: Record<VerifiedEntry['status'], string> = {
  ok: 'Verified: the file on disk hashes to the digest recorded at capture time.',
  modified:
    'MISMATCH: the file on disk no longer hashes to the digest recorded at capture time. ' +
    'It has been altered, re-saved, or replaced since it was captured.',
  missing: 'MISSING: the file recorded here was not found in the project folder.',
  unreadable: 'NOT CHECKED: the file could not be read when this report was made.'
}

function row(label: string, value: string): string {
  return `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`
}

function captureSection(
  entry: ManifestEntry,
  verified: VerifiedEntry | undefined,
  index: number,
  total: number
): string {
  const heading = total > 1 ? `Captured file ${index + 1} of ${total}` : 'Captured file'
  const rows: string[] = [
    row('File', `<code>${escapeHtml(entry.file)}</code>`),
    row('Captured', escapeHtml(humanTime(entry.capturedAt))),
    row('Method', escapeHtml(entry.method)),
    row('Size', escapeHtml(formatBytes(entry.bytes))),
    row(
      'SHA-256',
      `<code class="hash">${escapeHtml(groupHash(entry.sha256))}</code>`
    ),
    row('Captured by', escapeHtml(entry.tool))
  ]

  if (entry.timestamp) {
    const ts = entry.timestamp
    const authority =
      ts.authority === 'opentimestamps'
        ? 'OpenTimestamps (anchored in the Bitcoin blockchain)'
        : 'RFC 3161 timestamp authority'
    rows.push(
      row(
        'Timestamp token',
        `<code>${escapeHtml(ts.token)}</code><br><span class="muted">${escapeHtml(
          authority
        )} — ${escapeHtml(ts.service)}</span>`
      ),
      row(
        'Token obtained',
        escapeHtml(
          ts.assertedTime
            ? `${humanTime(ts.assertedTime)} — the time asserted by the authority`
            : `${humanTime(ts.requestedAt)} — the time the token was requested`
        )
      )
    )
  } else {
    rows.push(
      row(
        'Timestamp token',
        '<span class="muted">None. The digest above was not submitted to a timestamping service.</span>'
      )
    )
  }

  const status = verified
    ? `<p class="status status-${verified.status}">${escapeHtml(
        STATUS_WORDING[verified.status]
      )}${
        verified.status === 'modified' && verified.actual
          ? ` It now hashes to <code>${escapeHtml(verified.actual)}</code>.`
          : ''
      }</p>`
    : ''

  return `
    <section class="block">
      <h2>${escapeHtml(heading)}</h2>
      <table>${rows.join('')}</table>
      ${status}
    </section>`
}

function verifyingSection(entries: ManifestEntry[]): string {
  const first = entries[0]
  const file = first ? first.file : 'archive/<capture file>'
  const tokenSteps = entries
    .filter((e) => e.timestamp)
    .map(
      (e) =>
        `<li>Check the timestamp token for <code>${escapeHtml(e.file)}</code>:
         <pre>${escapeHtml(
           verificationCommandFor(e.timestamp!.authority, e.file, e.timestamp!.token)
         )}</pre>
         ${
           e.timestamp!.authority === 'opentimestamps'
             ? '<span class="muted">Uses the free OpenTimestamps client (<code>pip install opentimestamps-client</code>). ' +
               'The token proves the digest existed before the Bitcoin block it is anchored to; a recently made ' +
               'token may need <code>ots upgrade</code> first, once that block has been mined.</span>'
             : '<span class="muted">Uses OpenSSL, present on macOS and most Linux systems. The authority publishes ' +
               'the CA certificate needed for the last argument.</span>'
         }
        </li>`
    )
    .join('')

  return `
    <section class="block">
      <h2>How to verify this report</h2>
      <p>
        Every claim above can be checked without Backfile and without an internet connection,
        using the project folder this report came from.
      </p>
      <ol>
        <li>
          Confirm the captured file is unaltered by hashing it yourself and comparing the
          result to the SHA-256 above:
          <pre>shasum -a 256 "${escapeHtml(file)}"</pre>
          <span class="muted">On Windows: <code>certutil -hashfile "${escapeHtml(
            file
          )}" SHA256</code>. Any difference, in even one character, means the file is not the
          one that was captured.</span>
        </li>
        <li>
          Open the capture. MHTML files open in Chrome, Edge, or any Chromium-based browser
          and render the page as it was saved, offline, with its images and stylesheets
          embedded.
        </li>
        <li>
          Cross-check the same digests against <code>manifest.json</code> in the project
          folder, which lists every capture in the project.
        </li>
        ${tokenSteps}
      </ol>
    </section>`
}

/**
 * The report as a standalone HTML document.
 *
 * Self-contained by construction — no external stylesheet, no web font, and the
 * screenshot inlined as a data URL — because it is printed to a PDF that has to
 * be readable on a machine that has never seen this project folder.
 */
export function buildReportHtml(input: ReportInput): string {
  const {
    project,
    url,
    title,
    anchorText,
    foundIn = [],
    archiveIs,
    wayback,
    notes,
    entries,
    verification = [],
    screenshotDataUrl,
    generatedAt,
    tool
  } = input

  const verifiedByFile = new Map(verification.map((v) => [v.file, v]))

  const sourceRows = [
    row('URL', `<code class="url">${escapeHtml(url)}</code>`),
    row('Page title', escapeHtml(title || '—')),
    ...(anchorText ? [row('Cited as', `“${escapeHtml(anchorText)}”`)] : []),
    ...(foundIn.length > 0 ? [row('Cited in', escapeHtml(foundIn.join(', ')))] : []),
    ...(archiveIs
      ? [row('archive.today snapshot', `<code>${escapeHtml(archiveIs)}</code>`)]
      : []),
    ...(wayback ? [row('Wayback Machine snapshot', `<code>${escapeHtml(wayback)}</code>`)] : []),
    ...(notes ? [row('Notes', escapeHtml(notes))] : [])
  ].join('')

  const captures =
    entries.length > 0
      ? entries
          .map((entry, i) => captureSection(entry, verifiedByFile.get(entry.file), i, entries.length))
          .join('')
      : `<section class="block"><h2>Captured file</h2>
           <p class="muted">No local capture of this source is recorded in the project manifest.</p>
         </section>`

  const screenshot = screenshotDataUrl
    ? `<section class="block">
         <h2>Screenshot at capture time</h2>
         <img class="shot" src="${escapeHtml(screenshotDataUrl)}" alt="Screenshot of the captured page">
         <p class="muted">
           Rendered by the same browser session that saved the capture, at the moment of capture.
         </p>
       </section>`
    : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Capture report — ${escapeHtml(url)}</title>
<style>
  @page { size: letter; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font: 10.5pt/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #14161a;
    margin: 0;
  }
  header { border-bottom: 2px solid #14161a; padding-bottom: 10px; margin-bottom: 18px; }
  h1 { font-size: 17pt; margin: 0 0 4px; letter-spacing: -0.01em; }
  .kicker { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.09em; color: #5a616b; }
  h2 { font-size: 11pt; margin: 0 0 8px; }
  .block { margin-bottom: 20px; page-break-inside: avoid; }
  .lede { background: #f3f4f6; border-left: 3px solid #14161a; padding: 10px 12px; margin-bottom: 20px; }
  .lede p { margin: 0 0 6px; }
  .lede p:last-child { margin-bottom: 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; vertical-align: top; padding: 5px 8px; border-bottom: 1px solid #e2e4e8; }
  th { width: 150px; font-weight: 600; color: #3d434c; font-size: 9.5pt; }
  code { font-family: "SFMono-Regular", Menlo, Consolas, monospace; font-size: 9pt; word-break: break-all; }
  code.url { font-size: 9.5pt; }
  code.hash { letter-spacing: 0.02em; }
  pre {
    font-family: "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: 9pt; background: #f3f4f6; padding: 7px 9px; margin: 6px 0;
    white-space: pre-wrap; word-break: break-all; border-radius: 3px;
  }
  ol { padding-left: 18px; }
  ol > li { margin-bottom: 10px; }
  .muted { color: #5a616b; font-size: 9pt; }
  .status { padding: 7px 9px; margin: 8px 0 0; border-radius: 3px; font-size: 9.5pt; }
  .status-ok { background: #eaf6ed; border-left: 3px solid #2f7d43; }
  .status-modified { background: #fdecec; border-left: 3px solid #b3261e; font-weight: 600; }
  .status-missing, .status-unreadable { background: #fdf4e3; border-left: 3px solid #9a6800; }
  .shot { width: 100%; border: 1px solid #d6d9de; }
  footer { border-top: 1px solid #d6d9de; padding-top: 8px; margin-top: 24px; color: #5a616b; font-size: 8.5pt; }
</style>
</head>
<body>
  <header>
    <div class="kicker">Web capture report</div>
    <h1>${escapeHtml(title || url)}</h1>
    <div class="muted">Project: ${escapeHtml(project)}</div>
  </header>

  <div class="lede">
    <p>
      This document records the archiving of one web page. On the date shown below, the page at
      the URL below was loaded in a browser and saved to a file. The SHA-256 digest listed for
      that file is a fingerprint of its exact bytes: any change to the file, however small,
      produces a different digest.
    </p>
    <p>
      The report is generated by Backfile, an offline archiving tool. It is a record of what the
      tool did, not an assertion about the truth of the page's contents. Every claim it makes
      can be checked independently — see “How to verify this report”.
    </p>
  </div>

  <section class="block">
    <h2>Source</h2>
    <table>${sourceRows}</table>
  </section>

  ${captures}
  ${screenshot}
  ${verifyingSection(entries)}

  <footer>
    Generated ${escapeHtml(humanTime(generatedAt))} by ${escapeHtml(tool)} ·
    Project “${escapeHtml(project)}” · Digests are SHA-256.
  </footer>
</body>
</html>`
}

/**
 * A filename that pairs the report with the capture it describes, falling back
 * to the URL's own shape when there is no capture to pair with.
 */
export function reportFilename(url: string, entries: ManifestEntry[]): string {
  const first = entries[0]
  if (first) {
    const base = first.file.split('/').pop() ?? 'capture'
    return `${base.replace(/\.[^.]+$/, '')}-report.pdf`
  }
  let slug: string
  try {
    const parsed = new URL(url)
    slug = `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname}`
  } catch {
    slug = url
  }
  slug = slug
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${slug || 'capture'}-report.pdf`
}
