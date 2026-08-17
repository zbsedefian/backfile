/**
 * The only bridge between the renderer and the operating system.
 *
 * Every call is an explicit, named channel — the renderer gets no filesystem,
 * no shell and no Node. That matters more here than in most apps: Backfile
 * loads pages from the open web, and the whole promise of an offline desktop
 * tool for journalists is that their source material cannot phone home.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type {
  Article,
  CaptureRequest,
  CaptureResult,
  ServiceId,
  SourceLink
} from '../shared/types'
import type { BatchProgress } from '../main/capture/batch'
import type { Bounds, TabInfo } from '../main/browser/BrowserPane'
import type { RewritePlan, RewriteResult } from '../main/docx/rewriteLinks'
// Imported rather than redeclared: a hand-copied duplicate of this shape had
// already drifted from the real one, silently dropping a field.
import type { AnalyzeResult } from '../main/sources/analyze'
import type { MenuAction } from '../main/menu'
import type { NewSource } from '../main/sources/manual'
import type { RefreshResult, VerificationReport } from '../main/evidence/manifest'
import type { TimestampSettings } from '../main/evidence/timestamp'

const api = {
  chooseWorkspace: (): Promise<string | null> => ipcRenderer.invoke('workspace:choose'),
  lastWorkspace: (): Promise<string | null> => ipcRenderer.invoke('workspace:last'),
  scanWorkspace: (root: string): Promise<Article[]> => ipcRenderer.invoke('workspace:scan', root),
  hiddenArticles: (root: string): Promise<string[]> => ipcRenderer.invoke('workspace:hidden', root),
  /** Record which of a folder's documents count as the journalist's drafts. */
  setDrafts: (articlePath: string, documents: string[], chosen: string[]): Promise<void> =>
    ipcRenderer.invoke('article:setDrafts', articlePath, documents, chosen),
  /** Empty string means cancelled; a rejection means the pick was outside the folder. */
  pickDocument: (articlePath: string): Promise<string> =>
    ipcRenderer.invoke('article:pickDocument', articlePath),
  watchWorkspace: (root: string): Promise<void> => ipcRenderer.invoke('workspace:watch', root),
  onWorkspaceChanged: (handler: () => void): (() => void) => {
    const listener = (): void => handler()
    ipcRenderer.on('workspace:changed', listener)
    return () => ipcRenderer.removeListener('workspace:changed', listener)
  },
  setHiddenArticles: (root: string, names: string[]): Promise<void> =>
    ipcRenderer.invoke('workspace:setHidden', root, names),
  reloadArticle: (articlePath: string): Promise<Article | null> =>
    ipcRenderer.invoke('article:reload', articlePath),
  analyzeArticle: (articlePath: string, documents: string[]): Promise<AnalyzeResult> =>
    ipcRenderer.invoke('article:analyze', articlePath, documents),
  readSources: (articlePath: string): Promise<SourceLink[]> =>
    ipcRenderer.invoke('sources:read', articlePath),
  saveSources: (articlePath: string, links: SourceLink[]): Promise<void> =>
    ipcRenderer.invoke('sources:save', articlePath, links),
  createCollection: (root: string, name: string): Promise<string> =>
    ipcRenderer.invoke('workspace:createCollection', root, name),
  addSource: (
    articlePath: string,
    input: NewSource
  ): Promise<{ links: SourceLink[]; merged: boolean }> =>
    ipcRenderer.invoke('sources:add', articlePath, input),
  removeSource: (articlePath: string, url: string): Promise<SourceLink[]> =>
    ipcRenderer.invoke('sources:remove', articlePath, url),
  removeSources: (articlePath: string, urls: string[]): Promise<SourceLink[]> =>
    ipcRenderer.invoke('sources:removeMany', articlePath, urls),
  updateSourceUrl: (articlePath: string, oldUrl: string, newUrl: string): Promise<SourceLink[]> =>
    ipcRenderer.invoke('sources:updateUrl', articlePath, oldUrl, newUrl),
  capture: (req: CaptureRequest): Promise<CaptureResult> => ipcRenderer.invoke('capture:run', req),
  clearCapture: (articlePath: string, url: string, service: ServiceId): Promise<SourceLink[]> =>
    ipcRenderer.invoke('capture:clear', articlePath, url, service),
  /** A screenshot's bytes as a data URL, or null if it can no longer be read. */
  readScreenshot: (articlePath: string, relativePath: string): Promise<string | null> =>
    ipcRenderer.invoke('capture:readScreenshot', articlePath, relativePath),
  /** `urls` narrows the run to a selection; omitted, it covers the article. */
  captureAll: (articlePath: string, service: ServiceId, urls?: string[]): Promise<void> =>
    ipcRenderer.invoke('capture:batch', articlePath, service, urls),
  /** Omit the service to stop everything currently running. */
  cancelCapture: (service?: ServiceId): Promise<void> =>
    ipcRenderer.invoke('capture:cancel', service),
  skipCapture: (service?: ServiceId): Promise<void> =>
    ipcRenderer.invoke('capture:skip', service),
  /** Subscribe to batch progress. Returns an unsubscribe function. */
  onCaptureProgress: (handler: (p: BatchProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: BatchProgress): void => handler(p)
    ipcRenderer.on('capture:progress', listener)
    return () => ipcRenderer.removeListener('capture:progress', listener)
  },
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:writeText', text),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  openCapture: (articlePath: string, relativePath: string): Promise<void> =>
    ipcRenderer.invoke('shell:openCapture', articlePath, relativePath),
  revealArticle: (articlePath: string): Promise<void> =>
    ipcRenderer.invoke('shell:revealArticle', articlePath),
  revealCapture: (articlePath: string, relativePath: string): Promise<void> =>
    ipcRenderer.invoke('shell:revealCapture', articlePath, relativePath),

  // ---- embedded browser pane ----
  browserOpen: (url: string): Promise<string> => ipcRenderer.invoke('browser:open', url),
  viewCapture: (articlePath: string, relativePath: string): Promise<string | null> =>
    ipcRenderer.invoke('browser:openCapture', articlePath, relativePath),
  videoAvailable: (): Promise<boolean> => ipcRenderer.invoke('video:available'),
  /** Which browser's login cookies yt-dlp may use for a sign-in-required video, or null. */
  videoCookiesBrowser: (): Promise<string | null> => ipcRenderer.invoke('video:cookiesBrowser'),
  setVideoCookiesBrowser: (browser: string | null): Promise<void> =>
    ipcRenderer.invoke('video:setCookiesBrowser', browser),
  /** Downloads yt-dlp's own binary from GitHub into Backfile's own folder. */
  installYtDlp: (): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('video:install'),
  onYtDlpInstallProgress: (
    handler: (p: { receivedBytes: number; totalBytes: number | null }) => void
  ): (() => void) => {
    const listener = (_e: unknown, p: { receivedBytes: number; totalBytes: number | null }): void =>
      handler(p)
    ipcRenderer.on('video:installProgress', listener)
    return () => ipcRenderer.removeListener('video:installProgress', listener)
  },
  browserSetBounds: (bounds: Bounds): Promise<void> =>
    ipcRenderer.invoke('browser:setBounds', bounds),
  browserActivate: (id: string): Promise<void> => ipcRenderer.invoke('browser:activate', id),
  browserClose: (id: string): Promise<void> => ipcRenderer.invoke('browser:close', id),
  browserBreakOut: (id: string): Promise<void> => ipcRenderer.invoke('browser:breakOut', id),
  onBrowserTabs: (handler: (tabs: TabInfo[]) => void): (() => void) => {
    const listener = (_e: unknown, tabs: TabInfo[]): void => handler(tabs)
    ipcRenderer.on('browser:tabs', listener)
    return () => ipcRenderer.removeListener('browser:tabs', listener)
  },

  planRewrite: (articlePath: string, documentName: string): Promise<RewritePlan> =>
    ipcRenderer.invoke('docx:planRewrite', articlePath, documentName),
  rewriteDocx: (articlePath: string, documentName: string): Promise<RewriteResult> =>
    ipcRenderer.invoke('docx:rewrite', articlePath, documentName),
  supportEmail: (context: string): Promise<void> => ipcRenderer.invoke('support:email', context),

  // ---- evidence: timestamping, the manifest, verification, capture reports ----
  timestampSettings: (): Promise<TimestampSettings> =>
    ipcRenderer.invoke('evidence:timestampSettings'),
  setTimestampSettings: (settings: TimestampSettings): Promise<void> =>
    ipcRenderer.invoke('evidence:setTimestampSettings', settings),
  refreshManifest: (articlePath: string): Promise<RefreshResult> =>
    ipcRenderer.invoke('evidence:refreshManifest', articlePath),
  verifyCaptures: (articlePath: string): Promise<VerificationReport> =>
    ipcRenderer.invoke('evidence:verify', articlePath),
  /** Writes the PDF into the project's own archive/reports/ folder and returns its path. */
  generateCaptureReport: (
    articlePath: string,
    url: string
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('evidence:generateReport', articlePath, url),

  /** Menu items post named actions here rather than acting on their own. */
  onMenuAction: (handler: (action: MenuAction) => void): (() => void) => {
    const listener = (_e: unknown, action: MenuAction): void => handler(action)
    ipcRenderer.on('menu:action', listener)
    return () => ipcRenderer.removeListener('menu:action', listener)
  }
}

export type BackfileApi = typeof api

contextBridge.exposeInMainWorld('backfile', api)
