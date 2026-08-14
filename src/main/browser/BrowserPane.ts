/**
 * The embedded browser pane.
 *
 * Captures used to happen in their own BrowserWindow, which meant every capture
 * threw a window across whatever the journalist was doing. Web content now lives
 * inside the app as a tabbed pane, the way a terminal lives inside an editor, and
 * only leaves it when explicitly broken out into its own window.
 *
 * Electron's WebContentsView is not laid out by CSS — it is a native view
 * positioned over the window. So the renderer owns the geometry and reports the
 * pane's rectangle here whenever it changes; this class does nothing but obey it.
 */

import { BrowserWindow, WebContentsView } from 'electron'

export interface TabInfo {
  id: string
  url: string
  title: string
  loading: boolean
  active: boolean
  /** True once this tab has been detached into a standalone window. */
  brokenOut: boolean
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

interface Tab {
  id: string
  view: WebContentsView
  title: string
  url: string
  loading: boolean
  /** Set when broken out; the view then belongs to this window instead. */
  window: BrowserWindow | null
}

const HIDDEN: Bounds = { x: 0, y: 0, width: 0, height: 0 }

let nextId = 1

export class BrowserPane {
  private tabs: Tab[] = []
  private activeId: string | null = null
  private bounds: Bounds = HIDDEN
  private host: BrowserWindow | null = null

  /** Notified whenever any tab navigates, so captures can be auto-detected. */
  navigationListeners = new Set<(url: string, tabId: string) => void>()

  attach(host: BrowserWindow): void {
    this.host = host
  }

  private emitTabs(): void {
    if (!this.host || this.host.isDestroyed()) return
    this.host.webContents.send('browser:tabs', this.list())
  }

  list(): TabInfo[] {
    return this.tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title || t.url,
      loading: t.loading,
      active: t.id === this.activeId,
      brokenOut: t.window !== null
    }))
  }

  setBounds(bounds: Bounds): void {
    this.bounds = bounds
    this.layout()
  }

  /** Only the active, non-broken-out tab occupies the pane; the rest are parked. */
  private layout(): void {
    // A zero rectangle means the renderer has collapsed the pane. The view is a
    // native layer painted over the window, so hiding the React component does
    // nothing on its own — it has to be told, or it keeps covering the table.
    const collapsed = this.bounds.width === 0 || this.bounds.height === 0
    for (const tab of this.tabs) {
      if (tab.window) continue
      const visible = tab.id === this.activeId && !collapsed
      tab.view.setBounds(visible ? this.bounds : HIDDEN)
      tab.view.setVisible(visible)
    }
  }

  hasTab(id: string | null): boolean {
    return id !== null && this.tabs.some((t) => t.id === id)
  }

  open(url: string, opts: { activate?: boolean } = {}): string {
    if (!this.host) throw new Error('browser pane is not attached to a window')

    const id = `tab-${nextId++}`
    const view = new WebContentsView({
      webPreferences: {
        // Everything loaded here is untrusted third-party content.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // Persisted so an archive.is CAPTCHA cleared once covers later captures.
        partition: 'persist:capture-browser'
      }
    })

    const tab: Tab = { id, view, title: '', url, loading: true, window: null }
    this.tabs.push(tab)

    const wc = view.webContents
    const touch = (): void => {
      tab.url = wc.getURL()
      tab.title = wc.getTitle()
      this.emitTabs()
    }
    wc.on('page-title-updated', touch)
    wc.on('did-start-loading', () => {
      tab.loading = true
      this.emitTabs()
    })
    wc.on('did-stop-loading', () => {
      tab.loading = false
      touch()
    })
    const announce = (to: string): void => {
      tab.url = to
      for (const listener of this.navigationListeners) listener(to, id)
      this.emitTabs()
    }
    wc.on('did-navigate', (_e, to) => announce(to))
    wc.on('did-redirect-navigation', (_e, to) => announce(to))
    wc.on('did-navigate-in-page', (_e, to, isMainFrame) => {
      if (isMainFrame) announce(to)
    })
    // Keep target=_blank inside the pane rather than spawning stray windows.
    wc.setWindowOpenHandler(({ url: next }) => {
      this.open(next, { activate: true })
      return { action: 'deny' }
    })

    this.host.contentView.addChildView(view)
    void wc.loadURL(url)

    if (opts.activate !== false) this.activeId = id
    this.layout()
    this.emitTabs()
    return id
  }

  navigate(id: string, url: string): void {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return
    tab.loading = true
    void tab.view.webContents.loadURL(url)
    this.emitTabs()
  }

  activate(id: string): void {
    if (!this.tabs.some((t) => t.id === id)) return
    this.activeId = id
    this.layout()
    this.emitTabs()
  }

  close(id: string): void {
    const index = this.tabs.findIndex((t) => t.id === id)
    if (index === -1) return
    const [tab] = this.tabs.splice(index, 1)

    if (tab.window && !tab.window.isDestroyed()) {
      tab.window.destroy()
    } else if (this.host && !this.host.isDestroyed()) {
      this.host.contentView.removeChildView(tab.view)
    }
    // WebContentsView holds a live renderer; dropping the reference is not enough.
    tab.view.webContents.close()

    if (this.activeId === id) {
      const next = this.tabs.filter((t) => !t.window)
      this.activeId = next.length > 0 ? next[Math.min(index, next.length - 1)].id : null
    }
    this.layout()
    this.emitTabs()
  }

  /** Detach a tab into a standalone window, keeping its session and history. */
  breakOut(id: string): void {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab || tab.window || !this.host) return

    this.host.contentView.removeChildView(tab.view)

    const win = new BrowserWindow({
      width: 1100,
      height: 850,
      show: false,
      title: tab.title || tab.url,
      autoHideMenuBar: true
    })
    win.contentView.addChildView(tab.view)

    const fit = (): void => {
      const [w, h] = win.getContentSize()
      tab.view.setBounds({ x: 0, y: 0, width: w, height: h })
      tab.view.setVisible(true)
    }
    fit()
    win.on('resize', fit)
    win.on('closed', () => {
      tab.window = null
      // The tab goes back to being an ordinary pane tab rather than vanishing.
      const stillOpen = this.tabs.includes(tab)
      if (stillOpen && this.host && !this.host.isDestroyed()) {
        this.host.contentView.addChildView(tab.view)
        this.layout()
        this.emitTabs()
      }
    })
    win.showInactive()

    tab.window = win
    if (this.activeId === id) {
      const remaining = this.tabs.filter((t) => !t.window)
      this.activeId = remaining.length > 0 ? remaining[0].id : null
    }
    this.layout()
    this.emitTabs()
  }

  closeAll(): void {
    for (const tab of [...this.tabs]) this.close(tab.id)
  }

  get activeTabId(): string | null {
    return this.activeId
  }

  hasTabs(): boolean {
    return this.tabs.length > 0
  }
}

/** One pane per app; the main window owns it. */
export const browserPane = new BrowserPane()
