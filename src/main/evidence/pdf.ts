/**
 * Render the capture report to PDF.
 *
 * Uses the Chromium Backfile already ships rather than a PDF library: the
 * report is HTML with print styling built in, and `webContents.printToPDF` is
 * exactly Chrome's own "Print to PDF", which is what makes the output look
 * like a normal printed document rather than something a script assembled.
 */

import { BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      offscreen: true
    }
  })

  // Loaded from a real temp file rather than a data: URL, since printToPDF's
  // page-size CSS (@page) needs an actual navigation to take effect reliably.
  const tempFile = path.join(
    os.tmpdir(),
    `backfile-report-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`
  )
  try {
    await fs.writeFile(tempFile, html, 'utf8')
    await win.loadURL(pathToFileURL(tempFile).toString())
    return await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true
    })
  } finally {
    if (!win.isDestroyed()) win.destroy()
    await fs.rm(tempFile, { force: true }).catch(() => undefined)
  }
}
