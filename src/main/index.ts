import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { promises as fs } from 'node:fs'
import fs_sync from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { findYtDlp, resetYtDlpCache } from './capture/video'
import { installYtDlp } from './capture/ytdlpInstall'
import { Article, CaptureRequest, CaptureResult, ServiceId, SourceLink } from '../shared/types'
import { isInsideFolder, reloadArticle, scanWorkspace } from './project/scan'
import {
  resolveDrafts,
  setDrafts,
  withResolution,
  type DraftIndex
} from './project/drafts'
import { analyzeArticle, clearCapture, recordCapture } from './sources/analyze'
import { readSources, writeSources } from './sources/csv'
import {
  addSource,
  createCollection,
  NewSource,
  removeSource,
  removeSources,
  updateSourceUrl
} from './sources/manual'
import { adapterFor } from './capture'
import { BatchRunner } from './capture/batch'
import { LinkCheckRunner } from './health/checkLinks'
import { FEATURES } from '../shared/features'
import { browserPane, Bounds } from './browser/BrowserPane'
import { buildMenu } from './menu'
import { planDocxRewrite, rewriteDocxLinks } from './docx/rewriteLinks'
import {
  attestCapture,
  DEFAULT_TIMESTAMP_SETTINGS,
  generateCaptureReport,
  kindForService,
  refreshManifest,
  TimestampSettings,
  verifyManifest,
  type VerificationReport
} from './evidence'
import type { GenerateReportResult } from './evidence/generateReport'

const SETTINGS_FILE = (): string => path.join(app.getPath('userData'), 'settings.json')

interface Settings {
  lastWorkspace?: string
  /**
   * Folders the journalist has marked as "not an article", keyed by workspace
   * root. A working folder full of scratch .txt files looks exactly like an
   * article folder to any heuristic, so this is a decision only a human can
   * make — and one they should only have to make once.
   */
  hidden?: Record<string, string[]>
  /**
   * Which documents in each article folder are the journalist's own drafts,
   * keyed by absolute folder path. See project/drafts.ts for what an absent
   * entry means.
   */
  drafts?: DraftIndex
  /**
   * Which browser's login cookies yt-dlp may read to download a video that
   * requires being signed in — an age-gated video, mainly. Off (undefined)
   * by default: Backfile is otherwise account-free, and this is the one place
   * that would read something from a real, logged-in browser session rather
   * than act as a plain anonymous request. Opt-in, and global rather than
   * per-article, since it is a statement about what the journalist's own
   * machine is allowed to do, not about any one source.
   */
  videoCookiesBrowser?: string | null
  /**
   * Evidence-grade timestamping: submit each local/video capture's SHA-256 to
   * an independent authority and store the returned token beside it in
   * archive/, so a filing can show the capture existed, unchanged, before the
   * date on the token. Off by default — see evidence/timestamp.ts for why.
   */
  timestamping?: TimestampSettings
}

/**
 * Narrow each article's documents to the ones chosen as drafts, recording a
 * first-sight decision for folders nobody has curated yet. Runs on every scan
 * and reload so a folder is never analysed against a stale list.
 */
async function resolveArticleDrafts(articles: Article[]): Promise<Article[]> {
  let resolved: Article[] = []
  await updateSettings((settings) => {
    let index = settings.drafts ?? {}
    let changed = false

    resolved = articles.map((article) => {
      const { drafts, record } = resolveDrafts(article.path, article.documents, index)
      if (record !== null) {
        index = withResolution(index, article.path, record)
        changed = true
      }
      return { ...article, drafts }
    })

    return changed ? { ...settings, drafts: index } : null
  })
  return resolved
}

async function readSettings(): Promise<Settings> {
  try {
    return JSON.parse(await fs.readFile(SETTINGS_FILE(), 'utf8')) as Settings
  } catch {
    return {}
  }
}

async function writeSettings(settings: Settings): Promise<void> {
  // Written to a sibling and renamed, so an interrupted write can never leave a
  // half-file that parses as {} and silently forgets every decision in it.
  const file = SETTINGS_FILE()
  const temp = `${file}.tmp`
  await fs.writeFile(temp, JSON.stringify(settings, null, 2), 'utf8')
  await fs.rename(temp, file)
}

/**
 * Read-modify-write the settings file, one caller at a time.
 *
 * Every writer here rewrites the whole file, and there are several: unticking a
 * draft, hiding a folder, and the scan that adopts folders it has not seen
 * before. That last one runs on a filesystem watcher, so it fires at moments
 * nobody chose — including immediately after an analysis writes sources.csv.
 * Unserialised, two of them overlapping means both read the same file and the
 * slower write wins, quietly restoring a document the journalist just unticked.
 * The queue makes each update see the previous one's result.
 *
 * The callback returns null to mean "nothing to change", which avoids rewriting
 * the file on every scan of an unchanged workspace.
 */
let settingsQueue: Promise<unknown> = Promise.resolve()

function updateSettings(change: (settings: Settings) => Settings | null): Promise<void> {
  const next = settingsQueue.then(async () => {
    const settings = await readSettings()
    const updated = change(settings)
    if (updated !== null) await writeSettings(updated)
  })
  // The queue must keep advancing even if one update throws, or every later
  // write is dead behind it.
  settingsQueue = next.catch(() => undefined)
  return next
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 600,
    title: 'Backfile',
    // Matched to the OS so the window does not flash dark before a light
    // renderer paints. The renderer may still override the theme afterwards.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#12131a' : '#f4f5f8',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  browserPane.attach(mainWindow)

  mainWindow.on('closed', () => {
    browserPane.closeAll()
    mainWindow = null
  })
}

/** The field on a SourceLink that each service writes its result into. */
const FIELD_FOR: Record<ServiceId, 'archiveIs' | 'wayback' | 'localPath' | 'videoPath'> = {
  archiveIs: 'archiveIs',
  wayback: 'wayback',
  local: 'localPath',
  video: 'videoPath'
}

/** Recorded against every manifest entry, so a report says what made it. */
function currentTool(): string {
  return `Backfile ${app.getVersion()}`
}

function registerIpc(): void {
  ipcMain.handle('workspace:choose', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Choose your articles folder',
      // Documents are greyed out here because the selection is a folder, not a
      // file — say so, rather than letting it look like the app is broken.
      message: 'Select the folder that contains your article folders (not a document).',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const root = result.filePaths[0]
    await updateSettings((settings) => ({ ...settings, lastWorkspace: root }))
    return root
  })

  ipcMain.handle('workspace:last', async (): Promise<string | null> => {
    const { lastWorkspace } = await readSettings()
    if (!lastWorkspace) return null
    // A remembered folder may have been moved or deleted since last launch.
    try {
      await fs.access(lastWorkspace)
      return lastWorkspace
    } catch {
      return null
    }
  })

  ipcMain.handle('workspace:scan', async (_e, root: string): Promise<Article[]> => {
    return resolveArticleDrafts(await scanWorkspace(root))
  })

  /**
   * Watch the workspace so a folder created in Finder shows up without a
   * restart. Deliberately does not rescan on its own: it tells the renderer
   * something changed and lets it decide, so a rescan never lands in the middle
   * of a capture run and reshuffles the list under the journalist.
   */
  let watcher: fs_sync.FSWatcher | null = null
  let debounce: NodeJS.Timeout | null = null

  ipcMain.handle('workspace:watch', async (event, root: string): Promise<void> => {
    watcher?.close()
    watcher = null
    try {
      watcher = fs_sync.watch(root, { recursive: true }, (_type, filename) => {
        const name = filename?.toString() ?? ''
        // Backfile's own writes must not look like external changes, or every
        // capture would trigger a rescan of the whole workspace.
        if (
          name.includes(`${path.sep}archive${path.sep}`) ||
          name.startsWith('archive' + path.sep) ||
          name.endsWith('.tmp') ||
          name.includes('.DS_Store')
        ) {
          return
        }
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => {
          if (!event.sender.isDestroyed()) event.sender.send('workspace:changed')
        }, 900)
      })
    } catch {
      // Watching is a convenience; a folder that cannot be watched still works
      // through the Refresh button.
    }
  })

  ipcMain.handle('workspace:hidden', async (_e, root: string): Promise<string[]> => {
    const { hidden } = await readSettings()
    return hidden?.[root] ?? []
  })

  ipcMain.handle(
    'workspace:setHidden',
    async (_e, root: string, names: string[]): Promise<void> => {
      await updateSettings((settings) => ({
        ...settings,
        hidden: { ...(settings.hidden ?? {}), [root]: names }
      }))
    }
  )

  ipcMain.handle('article:reload', async (_e, articlePath: string): Promise<Article | null> => {
    const article = await reloadArticle(articlePath)
    if (!article) return null
    return (await resolveArticleDrafts([article]))[0]
  })

  ipcMain.handle(
    'article:setDrafts',
    async (_e, articlePath: string, documents: string[], chosen: string[]): Promise<void> => {
      await updateSettings((settings) => ({
        ...settings,
        drafts: setDrafts(settings.drafts ?? {}, articlePath, documents, chosen)
      }))
    }
  )

  /**
   * Choose a document to import, from inside the article's own folder only.
   *
   * Electron's open dialog has no way to actually confine the browser to a
   * directory — `defaultPath` only starts it there, the journalist can still
   * navigate anywhere on disk. So the lock is enforced here instead: every
   * document a folder holds is treated as a bare filename relative to that
   * folder everywhere else in the app (link extraction, the rewriter, the
   * capture archive), and a path from outside it would silently break all of
   * that rather than fail loudly, which is worse.
   */
  ipcMain.handle(
    'article:pickDocument',
    async (_e, articlePath: string): Promise<string> => {
      const result = await dialog.showOpenDialog({
        title: 'Import a document',
        message: "Choose a document already in this article's own folder.",
        buttonLabel: 'Import',
        defaultPath: articlePath,
        properties: ['openFile'],
        filters: [
          {
            name: 'Documents',
            extensions: ['docx', 'odt', 'html', 'htm', 'xhtml', 'txt', 'md', 'markdown']
          }
        ]
      })
      if (result.canceled || result.filePaths.length === 0) return ''

      const picked = result.filePaths[0]
      if (!isInsideFolder(picked, articlePath)) {
        throw new Error("Choose a file inside this article's own folder, not somewhere else.")
      }
      return path.basename(picked)
    }
  )

  ipcMain.handle(
    'article:analyze',
    async (_e, articlePath: string, documents: string[]) => {
      return analyzeArticle(articlePath, documents)
    }
  )

  ipcMain.handle(
    'sources:save',
    async (_e, articlePath: string, links: SourceLink[]): Promise<void> => {
      await writeSources(articlePath, links)
    }
  )

  ipcMain.handle('sources:read', async (_e, articlePath: string): Promise<SourceLink[]> => {
    return readSources(articlePath)
  })

  ipcMain.handle(
    'workspace:createCollection',
    async (_e, root: string, name: string): Promise<string> => {
      return createCollection(root, name)
    }
  )

  ipcMain.handle('sources:add', async (_e, articlePath: string, input: NewSource) => {
    return addSource(articlePath, input)
  })

  ipcMain.handle(
    'sources:remove',
    async (_e, articlePath: string, url: string): Promise<SourceLink[]> => {
      return removeSource(articlePath, url)
    }
  )

  ipcMain.handle(
    'sources:removeMany',
    async (_e, articlePath: string, urls: string[]): Promise<SourceLink[]> => {
      return removeSources(articlePath, urls)
    }
  )

  ipcMain.handle(
    'sources:updateUrl',
    async (_e, articlePath: string, oldUrl: string, newUrl: string): Promise<SourceLink[]> => {
      return updateSourceUrl(articlePath, oldUrl, newUrl)
    }
  )

  ipcMain.handle(
    'capture:clear',
    async (_e, articlePath: string, url: string, service: ServiceId): Promise<SourceLink[]> => {
      return clearCapture(articlePath, url, FIELD_FOR[service])
    }
  )

  ipcMain.handle('capture:run', async (_e, req: CaptureRequest): Promise<CaptureResult> => {
    const adapter = adapterFor(req.service)
    const { videoCookiesBrowser, timestamping } = await readSettings()
    const result = await adapter.capture(req.url, {
      articlePath: req.articlePath,
      cookiesBrowser: videoCookiesBrowser
    })
    if (result.ok && result.value) {
      await recordCapture(
        req.articlePath,
        req.url,
        FIELD_FOR[req.service],
        result.value,
        result.title,
        result.screenshotPath
      )
      // Best-effort: see attestCapture's own doc comment for why a slow or
      // unreachable timestamp authority must never fail a capture that
      // already succeeded and is already saved to disk.
      const kind = kindForService(req.service)
      if (kind) {
        await attestCapture({
          projectPath: req.articlePath,
          url: req.url,
          title: result.title,
          relativePath: result.value,
          kind,
          screenshotPath: result.screenshotPath,
          tool: currentTool(),
          timestamping: timestamping ?? DEFAULT_TIMESTAMP_SETTINGS
        }).catch(() => undefined)
      }
    }
    return result
  })

  /*
   * One run per service, several services at once.
   *
   * Two archive.is runs would fight over the single capture tab and the one
   * CAPTCHA, so that is still forbidden — but blocking every service behind
   * one global lock meant waiting out a long archive.is run before local
   * copies could even start, which is exactly the time they should have been
   * using.
   */
  const activeBatches = new Map<ServiceId, BatchRunner>()

  ipcMain.handle(
    'capture:batch',
    async (
      event,
      articlePath: string,
      service: ServiceId,
      urls?: string[]
    ): Promise<void> => {
      if (activeBatches.has(service)) {
        throw new Error(`a ${service} run is already in progress`)
      }
      const runner = new BatchRunner()
      activeBatches.set(service, runner)
      try {
        const all = await readSources(articlePath)
        // A selection narrows the queue; everything else about the run — the
        // pacing, the single archive.is session, cancellation — is unchanged.
        // An empty list means "capture nothing", not "capture everything" —
        // the difference matters when every source in a folder belongs to a
        // document the journalist has just unticked.
        const wanted = urls ? new Set(urls) : null
        const links = wanted ? all.filter((l) => wanted.has(l.url)) : all
        const { videoCookiesBrowser, timestamping } = await readSettings()
        await runner.run(
          articlePath,
          links,
          service,
          videoCookiesBrowser ?? null,
          (progress) => {
            if (!event.sender.isDestroyed()) event.sender.send('capture:progress', progress)
          },
          timestamping ?? DEFAULT_TIMESTAMP_SETTINGS,
          currentTool()
        )
      } finally {
        activeBatches.delete(service)
      }
    }
  )

  ipcMain.handle('capture:cancel', async (_e, service?: ServiceId): Promise<void> => {
    if (service) activeBatches.get(service)?.cancel()
    else for (const runner of activeBatches.values()) runner.cancel()
  })

  ipcMain.handle('capture:skip', async (_e, service?: ServiceId): Promise<void> => {
    if (service) activeBatches.get(service)?.skip()
    else for (const runner of activeBatches.values()) runner.skip()
  })

  /**
   * One run per article — there is nothing to parallelise a second run
   * against, unlike captures which split by service.
   *
   * Gated on FEATURES.linkHealth so this can be switched off for a paid tier
   * later without touching the handler itself.
   */
  const activeHealthRuns = new Map<string, LinkCheckRunner>()

  ipcMain.handle(
    'health:checkLinks',
    async (event, articlePath: string, urls?: string[]): Promise<void> => {
      if (!FEATURES.linkHealth) throw new Error('link checking is not enabled')
      if (activeHealthRuns.has(articlePath)) {
        throw new Error('a link check is already running for this article')
      }
      const runner = new LinkCheckRunner()
      activeHealthRuns.set(articlePath, runner)
      try {
        const all = await readSources(articlePath)
        // Same reasoning as capture:batch: an empty selection means "check
        // nothing," not "check everything."
        const wanted = urls ? new Set(urls) : null
        const links = wanted ? all.filter((l) => wanted.has(l.url)) : all
        await runner.run(articlePath, links, (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('health:progress', progress)
        })
      } finally {
        activeHealthRuns.delete(articlePath)
      }
    }
  )

  ipcMain.handle('health:cancel', async (_e, articlePath: string): Promise<void> => {
    activeHealthRuns.get(articlePath)?.cancel()
  })

  // Routed through main rather than the renderer's own navigator.clipboard so
  // it behaves the same regardless of whether the page is loaded from file://
  // (production) or a dev server URL.
  ipcMain.handle('clipboard:writeText', async (_e, text: string): Promise<void> => {
    clipboard.writeText(text)
  })

  ipcMain.handle('shell:openExternal', async (_e, url: string): Promise<void> => {
    // Only ever hand real web URLs to the OS, never file:// or custom schemes.
    if (!/^https?:\/\//i.test(url)) return
    await shell.openExternal(url)
  })

  ipcMain.handle(
    'shell:openCapture',
    async (_e, articlePath: string, relativePath: string): Promise<void> => {
      const full = path.resolve(articlePath, relativePath)
      // Refuse to open anything that escaped the article folder.
      if (!full.startsWith(path.resolve(articlePath))) return
      await shell.openPath(full)
    }
  )

  ipcMain.handle('shell:revealArticle', async (_e, articlePath: string): Promise<void> => {
    shell.showItemInFolder(articlePath)
  })

  ipcMain.handle(
    'shell:revealCapture',
    async (_e, articlePath: string, relativePath: string): Promise<void> => {
      const full = path.resolve(articlePath, relativePath)
      if (!full.startsWith(path.resolve(articlePath))) return
      shell.showItemInFolder(full)
    }
  )

  // ---- embedded browser pane ----

  ipcMain.handle('browser:open', async (_e, url: string): Promise<string> => {
    return browserPane.open(url)
  })

  /**
   * View a captured file in the pane. Chromium reads MHTML natively, which is
   * the whole reason captures are stored in that format — the alternative is
   * handing the file to an OS that, on macOS, often has nothing to open it with.
   */
  ipcMain.handle(
    'browser:openCapture',
    async (_e, articlePath: string, relativePath: string): Promise<string | null> => {
      const full = path.resolve(articlePath, relativePath)
      if (!full.startsWith(path.resolve(articlePath))) return null
      try {
        await fs.access(full)
      } catch {
        return null
      }
      return browserPane.open(pathToFileURL(full).toString())
    }
  )

  /**
   * A screenshot as a data URL, for the detail pane's thumbnail.
   *
   * The renderer's CSP allows "data:" images but not "file:" — the whole
   * point of running captured content through a sandboxed, contextIsolated
   * window in the first place — so the main process reads the PNG and hands
   * back bytes rather than a path the renderer could load itself.
   */
  ipcMain.handle(
    'capture:readScreenshot',
    async (_e, articlePath: string, relativePath: string): Promise<string | null> => {
      const full = path.resolve(articlePath, relativePath)
      if (!full.startsWith(path.resolve(articlePath))) return null
      try {
        const buffer = await fs.readFile(full)
        return `data:image/png;base64,${buffer.toString('base64')}`
      } catch {
        return null
      }
    }
  )

  ipcMain.handle('video:available', async (): Promise<boolean> => {
    resetYtDlpCache()
    return (await findYtDlp()) !== null
  })

  ipcMain.handle('video:cookiesBrowser', async (): Promise<string | null> => {
    const { videoCookiesBrowser } = await readSettings()
    return videoCookiesBrowser ?? null
  })

  ipcMain.handle(
    'video:setCookiesBrowser',
    async (_e, browser: string | null): Promise<void> => {
      await updateSettings((settings) => ({ ...settings, videoCookiesBrowser: browser }))
      // The Video Cookies submenu shows the active choice as a radio dot, and
      // Electron menus are static once set — rebuilding is how the dot moves.
      const { timestamping } = await readSettings()
      buildMenu(browser, (timestamping ?? DEFAULT_TIMESTAMP_SETTINGS).mode)
    }
  )

  ipcMain.handle(
    'video:install',
    async (event): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
      try {
        const installedPath = await installYtDlp((p) => {
          if (!event.sender.isDestroyed()) event.sender.send('video:installProgress', p)
        })
        resetYtDlpCache()
        return { ok: true, path: installedPath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('browser:setBounds', async (_e, bounds: Bounds): Promise<void> => {
    browserPane.setBounds(bounds)
  })
  ipcMain.handle('browser:activate', async (_e, id: string): Promise<void> => {
    browserPane.activate(id)
  })
  ipcMain.handle('browser:close', async (_e, id: string): Promise<void> => {
    browserPane.close(id)
  })
  ipcMain.handle('browser:breakOut', async (_e, id: string): Promise<void> => {
    browserPane.breakOut(id)
  })

  ipcMain.handle(
    'docx:planRewrite',
    async (_e, articlePath: string, documentName: string) => {
      const links = await readSources(articlePath)
      return planDocxRewrite(articlePath, documentName, links)
    }
  )

  ipcMain.handle(
    'docx:rewrite',
    async (_e, articlePath: string, documentName: string) => {
      const links = await readSources(articlePath)
      return rewriteDocxLinks(articlePath, documentName, links)
    }
  )

  // ---- evidence: timestamping, the manifest, verification, capture reports ----

  ipcMain.handle('evidence:timestampSettings', async (): Promise<TimestampSettings> => {
    const { timestamping } = await readSettings()
    return timestamping ?? DEFAULT_TIMESTAMP_SETTINGS
  })

  ipcMain.handle(
    'evidence:setTimestampSettings',
    async (_e, settings: TimestampSettings): Promise<void> => {
      await updateSettings((s) => ({ ...s, timestamping: settings }))
      // The Timestamping submenu shows the active mode as a radio dot; see
      // the Video Cookies submenu for why the menu has to be rebuilt for it
      // to move.
      const { videoCookiesBrowser } = await readSettings()
      buildMenu(videoCookiesBrowser ?? null, settings.mode)
    }
  )

  /**
   * Bring the manifest up to date with whatever is on disk: an entry for every
   * capture that has none. Run by hand (Evidence menu) as well as automatically
   * whenever it is convenient, since it never overwrites a recorded hash — see
   * evidence/manifest.ts for the rule that makes that safe.
   */
  ipcMain.handle(
    'evidence:refreshManifest',
    async (_e, articlePath: string) => {
      const links = await readSources(articlePath)
      return refreshManifest(articlePath, links, currentTool())
    }
  )

  ipcMain.handle(
    'evidence:verify',
    async (_e, articlePath: string): Promise<VerificationReport> => {
      return verifyManifest(articlePath)
    }
  )

  ipcMain.handle(
    'evidence:generateReport',
    async (
      _e,
      articlePath: string,
      url: string
    ): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
      try {
        const result: GenerateReportResult = await generateCaptureReport(
          articlePath,
          url,
          currentTool()
        )
        return { ok: true, path: result.relativePath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  /**
   * Open a pre-filled support email in the user's mail client.
   *
   * Backfile has no server and no telemetry, which is a deliberate promise, so
   * it cannot send mail itself — handing the draft to the local mail client is
   * the only way to ask for help that does not quietly break that promise.
   */
  ipcMain.handle('support:email', async (_e, context: string): Promise<void> => {
    const body = [
      'Describe the problem or question here:',
      '',
      '',
      '---',
      `Backfile ${app.getVersion()}`,
      `${process.platform} ${process.arch} · Electron ${process.versions.electron}`,
      context ? `Context: ${context}` : ''
    ].join('\n')

    const url =
      'mailto:zacharysedefian@protonmail.com' +
      `?subject=${encodeURIComponent('Backfile — help')}` +
      `&body=${encodeURIComponent(body)}`
    await shell.openExternal(url)
  })
}

app.whenReady().then(async () => {
  registerIpc()
  // The menu shows the stored Video Cookies and Timestamping choices, so it
  // needs the settings before it is built the first time.
  const { videoCookiesBrowser, timestamping } = await readSettings()
  buildMenu(videoCookiesBrowser ?? null, (timestamping ?? DEFAULT_TIMESTAMP_SETTINGS).mode)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
