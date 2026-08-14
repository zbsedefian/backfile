import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { promises as fs } from 'node:fs'
import fs_sync from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { findYtDlp, resetYtDlpCache } from './capture/video'
import { Article, CaptureRequest, CaptureResult, ServiceId, SourceLink } from '../shared/types'
import { reloadArticle, scanWorkspace } from './project/scan'
import { analyzeArticle, clearCapture, recordCapture } from './sources/analyze'
import { readSources, writeSources } from './sources/csv'
import { addSource, createCollection, NewSource, removeSource, updateSourceUrl } from './sources/manual'
import { adapterFor } from './capture'
import { BatchRunner } from './capture/batch'
import { browserPane, Bounds } from './browser/BrowserPane'
import { buildMenu } from './menu'
import { planDocxRewrite, rewriteDocxLinks } from './docx/rewriteLinks'

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
}

async function readSettings(): Promise<Settings> {
  try {
    return JSON.parse(await fs.readFile(SETTINGS_FILE(), 'utf8')) as Settings
  } catch {
    return {}
  }
}

async function writeSettings(settings: Settings): Promise<void> {
  await fs.writeFile(SETTINGS_FILE(), JSON.stringify(settings, null, 2), 'utf8')
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
    await writeSettings({ ...(await readSettings()), lastWorkspace: root })
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
    return scanWorkspace(root)
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
      const settings = await readSettings()
      await writeSettings({
        ...settings,
        hidden: { ...(settings.hidden ?? {}), [root]: names }
      })
    }
  )

  ipcMain.handle('article:reload', async (_e, articlePath: string): Promise<Article | null> => {
    return reloadArticle(articlePath)
  })

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
    const result = await adapter.capture(req.url, { articlePath: req.articlePath })
    if (result.ok && result.value) {
      await recordCapture(req.articlePath, req.url, FIELD_FOR[req.service], result.value)
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
    async (event, articlePath: string, service: ServiceId): Promise<void> => {
      if (activeBatches.has(service)) {
        throw new Error(`a ${service} run is already in progress`)
      }
      const runner = new BatchRunner()
      activeBatches.set(service, runner)
      try {
        const links = await readSources(articlePath)
        await runner.run(articlePath, links, service, (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('capture:progress', progress)
        })
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

  ipcMain.handle('video:available', async (): Promise<boolean> => {
    resetYtDlpCache()
    return (await findYtDlp()) !== null
  })
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

app.whenReady().then(() => {
  registerIpc()
  buildMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
