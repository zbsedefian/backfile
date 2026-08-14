import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RewritePlan } from '../main/docx/rewriteLinks'
import type { Article, ServiceId, SourceLink } from '../shared/types'
import { tierOf } from '../shared/types'
import { isLikelyVideoPage } from '../shared/links'
import type { TabInfo } from '../main/browser/BrowserPane'
import { Sidebar } from './components/Sidebar'
import { SourceTable, busyKey, filterLinks, sortLinks, type Sort } from './components/SourceTable'
import { DetailPane } from './components/DetailPane'
import { BrowserPanel } from './components/BrowserPanel'
import { PublishPreview } from './components/PublishPreview'
import { AddSourceDialog } from './components/AddSourceDialog'
import { CaptureMenu } from './components/CaptureMenu'
import { ResizeHandle } from './components/ResizeHandle'
import { tierCounts } from './components/Tier'
import { clamp, usePersistentState } from './usePersistentState'

type Filter = 'all' | 'unsecured' | 'secured'

export function App(): JSX.Element {
  const [root, setRoot] = useState<string | null>(null)
  const [articles, setArticles] = useState<Article[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [filter, setFilter] = useState<Filter>('all')
  const [status, setStatus] = useState<string>('')
  const [analyzing, setAnalyzing] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [publishTarget, setPublishTarget] = useState<string>('')
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [paneOpen, setPaneOpen] = useState(true)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>({ key: 'tier', dir: 'asc' })
  const [hidden, setHidden] = useState<string[]>([])
  const [plan, setPlan] = useState<RewritePlan | null>(null)
  const [addingSource, setAddingSource] = useState(false)
  const [savingSource, setSavingSource] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const [theme, setTheme] = usePersistentState<'system' | 'light' | 'dark'>(
    'layout.theme',
    'system'
  )

  // "system" deliberately sets no attribute, leaving the CSS media query in
  // charge, so the app follows the OS as it changes rather than at launch only.
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
  }, [theme])

  // Layout, remembered across restarts.
  const [sidebarWidth, setSidebarWidth] = usePersistentState('layout.sidebar', 260)
  const [detailWidth, setDetailWidth] = usePersistentState('layout.detail', 300)
  const [browserHeight, setBrowserHeight] = usePersistentState('layout.browser', 420)
  const [sidebarOpen, setSidebarOpen] = usePersistentState('layout.sidebarOpen', true)
  const [detailOpen, setDetailOpen] = usePersistentState('layout.detailOpen', true)
  const [batch, setBatch] = useState<{
    done: number
    total: number
    needsHuman: boolean
    url: string
  } | null>(null)

  // Mirrors `batch` in a ref so the workspace watcher can check it without
  // re-subscribing every time progress ticks.
  const batchRef = useRef<unknown>(null)
  useEffect(() => {
    batchRef.current = batch
  }, [batch])

  const selected = useMemo(
    () => articles.find((a) => a.path === selectedPath) ?? null,
    [articles, selectedPath]
  )

  /** Only .docx can be republished; a .txt link list has nothing to rewrite. */
  const docxDocuments = useMemo(
    () => selected?.documents.filter((d) => d.toLowerCase().endsWith('.docx')) ?? [],
    [selected]
  )

  useEffect(() => {
    setPublishTarget(docxDocuments[0] ?? '')
  }, [docxDocuments])

  const loadWorkspace = useCallback(async (dir: string) => {
    setRoot(dir)
    const [found, hiddenNames] = await Promise.all([
      window.backfile.scanWorkspace(dir),
      window.backfile.hiddenArticles(dir)
    ])
    setArticles(found)
    setHidden(hiddenNames)
    const visibleCount = found.filter((a) => !hiddenNames.includes(a.name)).length
    setStatus(`${visibleCount} article folder${visibleCount === 1 ? '' : 's'}`)
  }, [])

  /**
   * Re-scan without disturbing the current selection, unlike opening a
   * workspace afresh. Skipped during a capture run: reshuffling the list
   * mid-batch would move rows under the journalist for no benefit.
   */
  const refreshWorkspace = useCallback(async () => {
    if (!root || batchRef.current) return
    const found = await window.backfile.scanWorkspace(root)
    setArticles(found)
  }, [root])

  // Watch the workspace so a folder made in Finder appears on its own.
  useEffect(() => {
    if (!root) return
    void window.backfile.watchWorkspace(root)
    return window.backfile.onWorkspaceChanged(() => {
      void refreshWorkspace()
    })
  }, [root, refreshWorkspace])

  const updateHidden = useCallback(
    (names: string[]) => {
      setHidden(names)
      if (root) void window.backfile.setHiddenArticles(root, names)
    },
    [root]
  )

  useEffect(() => {
    void (async () => {
      const last = await window.backfile.lastWorkspace()
      if (last) await loadWorkspace(last)
    })()
  }, [loadWorkspace])

  const hadTabs = useRef(false)
  useEffect(() => {
    return window.backfile.onBrowserTabs((next) => {
      setTabs(next)
      // Only reveal the pane when a tab first appears. Tab events also fire for
      // title and loading changes, so reacting to every one of them re-opened
      // the pane seconds after the journalist deliberately hid it.
      if (next.length > 0 && !hadTabs.current) setPaneOpen(true)
      hadTabs.current = next.length > 0
    })
  }, [])

  const chooseWorkspace = useCallback(async () => {
    const dir = await window.backfile.chooseWorkspace()
    if (dir) {
      setSelectedPath(null)
      setSelectedUrl(null)
      await loadWorkspace(dir)
    }
  }, [loadWorkspace])

  /** Replace one article in place so the sidebar counts stay live. */
  const patchArticle = useCallback((articlePath: string, sources: SourceLink[]) => {
    setArticles((prev) =>
      prev.map((a) => (a.path === articlePath ? { ...a, sources, hasSourcesFile: true } : a))
    )
  }, [])

  const analyze = useCallback(async () => {
    if (!selected) return
    setAnalyzing(true)
    setStatus(`Reading ${selected.documents.length} file(s)…`)
    try {
      const result = await window.backfile.analyzeArticle(selected.path, selected.documents)
      patchArticle(selected.path, result.links)
      const bits = [`${result.links.length} sources`]
      if (result.added) bits.push(`${result.added} new`)
      if (result.imported) bits.push(`${result.imported} snapshots imported`)
      if (result.updated) bits.push(`${result.updated} updated`)
      if (result.orphaned) bits.push(`${result.orphaned} no longer cited`)
      setStatus(bits.join(' · '))
    } catch (err) {
      setStatus(`Analyze failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setAnalyzing(false)
    }
  }, [selected, patchArticle])

  const capture = useCallback(
    async (url: string, service: ServiceId) => {
      if (!selected) return
      const key = busyKey(url, service)
      setBusy((b) => ({ ...b, [key]: true }))
      setStatus(
        service === 'archiveIs'
          ? 'Capturing in the browser pane below — clear the CAPTCHA if one appears.'
          : `Capturing ${service}…`
      )
      try {
        const result = await window.backfile.capture({
          articlePath: selected.path,
          url,
          service
        })
        const sources = await window.backfile.readSources(selected.path)
        patchArticle(selected.path, sources)
        setStatus(
          result.ok
            ? `Saved: ${result.value}`
            : result.error === 'cancelled'
              ? 'Capture cancelled.'
              : `Failed: ${result.error}`
        )
      } catch (err) {
        setStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setBusy((b) => {
          const next = { ...b }
          delete next[key]
          return next
        })
      }
    },
    [selected, patchArticle]
  )

  /** Stream batch progress into the status bar and the inline progress strip. */
  useEffect(() => {
    return window.backfile.onCaptureProgress((p) => {
      if (p.phase === 'finished') {
        setBatch(null)
        setStatus(
          p.detail === 'Stopped.'
            ? `Stopped — ${p.succeeded ?? 0} captured.`
            : `Done. ${p.succeeded ?? 0} captured${p.failed ? `, ${p.failed} failed` : ''}.`
        )
        if (selectedPath) {
          void window.backfile
            .readSources(selectedPath)
            .then((sources) => patchArticle(selectedPath, sources))
        }
        return
      }
      setBatch({
        done: p.done,
        total: p.total,
        needsHuman: p.phase === 'needs-human',
        url: p.url
      })
      if (p.phase === 'needs-human') {
        // The message says "solve it in the pane below", so the pane had better
        // be below. It may have been hidden, or collapsed by an earlier run.
        setPaneOpen(true)
        setStatus(p.detail ?? 'Waiting for you…')
      }
      else if (p.phase === 'saved') setStatus(`${p.done}/${p.total} · saved ${p.detail}`)
      else if (p.phase === 'failed') setStatus(`${p.done}/${p.total} · failed: ${p.detail}`)
      else setStatus(`${p.done}/${p.total} · capturing ${p.url}`)
    })
  }, [selectedPath, patchArticle])

  const captureAll = useCallback(
    async (service: ServiceId) => {
      if (!selected) return
      setBatch({ done: 0, total: 0, needsHuman: false, url: '' })
      // archive.is runs in the pane, so make sure the journalist can see it.
      if (service === 'archiveIs') setPaneOpen(true)
      try {
        await window.backfile.captureAll(selected.path, service)
      } catch (err) {
        setStatus(`Batch failed: ${err instanceof Error ? err.message : String(err)}`)
        setBatch(null)
      } finally {
        const sources = await window.backfile.readSources(selected.path)
        patchArticle(selected.path, sources)
      }
    },
    [selected, patchArticle]
  )

  const openPublishPreview = useCallback(async () => {
    if (!selected || !publishTarget) return
    try {
      setPlan(await window.backfile.planRewrite(selected.path, publishTarget))
    } catch (err) {
      setStatus(`Could not read ${publishTarget}: ${err instanceof Error ? err.message : err}`)
    }
  }, [selected, publishTarget])

  const publish = useCallback(async () => {
    if (!selected || !publishTarget) return
    setPublishing(true)
    try {
      const result = await window.backfile.rewriteDocx(selected.path, publishTarget)
      setPlan(null)
      setStatus(
        `Wrote “${result.outputPath}” — ${result.rewritten} link${
          result.rewritten === 1 ? '' : 's'
        } repointed at snapshots${result.untouched ? `, ${result.untouched} left as-is` : ''}.`
      )
      const refreshed = await window.backfile.reloadArticle(selected.path)
      if (refreshed) {
        setArticles((prev) => prev.map((a) => (a.path === refreshed.path ? refreshed : a)))
      }
    } catch (err) {
      setStatus(`Publish failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPublishing(false)
    }
  }, [selected, publishTarget])

  const createCollection = useCallback(
    async (name: string) => {
      if (!root) return
      try {
        const folder = await window.backfile.createCollection(root, name)
        const found = await window.backfile.scanWorkspace(root)
        setArticles(found)
        // Select it immediately — you made it because you want to put something in it.
        setSelectedPath(folder)
        setSelectedUrl(null)
        setStatus(`Created "${name}". Add links with + Add link.`)
      } catch (err) {
        setStatus(`Could not create it: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [root]
  )

  const saveNewSource = useCallback(
    async (input: { url: string; archiveIs: string; wayback: string; notes: string }) => {
      if (!selected) return
      setSavingSource(true)
      try {
        const { links, merged } = await window.backfile.addSource(selected.path, input)
        patchArticle(selected.path, links)
        setAddingSource(false)
        setStatus(merged ? 'Already recorded — merged into the existing entry.' : 'Link added.')
      } catch (err) {
        setStatus(`Could not add it: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setSavingSource(false)
      }
    },
    [selected, patchArticle]
  )

  const deleteSource = useCallback(
    async (url: string) => {
      if (!selected) return
      const links = await window.backfile.removeSource(selected.path, url)
      patchArticle(selected.path, links)
      setSelectedUrl(null)
      setStatus('Removed.')
    },
    [selected, patchArticle]
  )

  const editSourceUrl = useCallback(
    async (oldUrl: string, newUrl: string) => {
      if (!selected || !newUrl.trim() || newUrl === oldUrl) return
      const links = await window.backfile.updateSourceUrl(selected.path, oldUrl, newUrl)
      patchArticle(selected.path, links)
      setSelectedUrl(newUrl.trim())
    },
    [selected, patchArticle]
  )

  const toggleExcluded = useCallback(
    async (url: string, excluded: boolean) => {
      if (!selected) return
      const next = selected.sources.map((l) =>
        l.url === url
          ? {
              ...l,
              excluded,
              excludedReason: excluded ? l.excludedReason || 'marked by hand' : ''
            }
          : l
      )
      patchArticle(selected.path, next)
      await window.backfile.saveSources(selected.path, next)
    },
    [selected, patchArticle]
  )

  const visible = useMemo(() => {
    if (!selected) return []
    const byFilter = selected.sources.filter((l) => {
      if (filter === 'all') return true
      const tier = tierOf(l)
      const secured = l.excluded || tier === 'silver' || tier === 'gold'
      return filter === 'secured' ? secured : !secured
    })
    return sortLinks(filterLinks(byFilter, query), sort)
  }, [selected, filter, query, sort])

  const counts = useMemo(() => (selected ? tierCounts(selected.sources) : null), [selected])

  /** How many sources each service still owes, so the buttons can say so. */
  const pendingCounts = useMemo(() => {
    const links = selected?.sources ?? []
    const outstanding = (field: 'archiveIs' | 'wayback' | 'localPath'): number =>
      links.filter((l) => !l.excluded && !l[field]).length
    return {
      archiveIs: outstanding('archiveIs'),
      wayback: outstanding('wayback'),
      local: outstanding('localPath')
    }
  }, [selected])

  /**
   * Video pages still missing their video. Only offered when there are any,
   * since most collections contain none and an always-present button would
   * imply every source has a video worth downloading.
   */
  const videoPending = useMemo(
    () =>
      (selected?.sources ?? []).filter(
        (l) => !l.excluded && !l.videoPath && isLikelyVideoPage(l.url)
      ).length,
    [selected]
  )

  // Checked lazily: yt-dlp is optional, and a GUI app does not inherit the
  // shell PATH, so a user who can run it in a terminal may still not have it here.
  const [videoAvailable, setVideoAvailable] = useState<boolean | null>(null)
  useEffect(() => {
    if (videoPending > 0 && videoAvailable === null) {
      void window.backfile.videoAvailable().then(setVideoAvailable)
    }
  }, [videoPending, videoAvailable])

  /**
   * Keyboard navigation.
   *
   * Working through a hundred sources is a repetitive job, and reaching for the
   * mouse for every row is what makes it feel like one. Shortcuts are ignored
   * while typing in a field, so a "/" in a search box stays a slash.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement

      if (e.key === 'Escape') {
        if (addingSource) return setAddingSource(false)
        if (plan) return setPlan(null)
        if (typing) return (target as HTMLElement).blur()
        if (query) return setQuery('')
        return
      }

      if ((e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key === 'f')) && !typing) {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }

      if (typing || plan || addingSource) return

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (visible.length === 0) return
        e.preventDefault()
        const index = visible.findIndex((l) => l.url === selectedUrl)
        const step = e.key === 'ArrowDown' ? 1 : -1
        // From no selection, Down starts at the top and Up starts at the bottom.
        const next =
          index === -1
            ? step === 1
              ? 0
              : visible.length - 1
            : clamp(index + step, 0, visible.length - 1)
        setSelectedUrl(visible[next].url)
        document
          .querySelector(`[data-url="${CSS.escape(visible[next].url)}"]`)
          ?.scrollIntoView({ block: 'nearest' })
        return
      }

      if (!selectedUrl) return
      const link = visible.find((l) => l.url === selectedUrl)
      if (!link) return

      if (e.key === 'Enter') {
        e.preventDefault()
        // Enter opens the source; Shift+Enter jumps to its snapshot instead.
        if (e.shiftKey && link.archiveIs) openExternal(link.archiveIs)
        else openInPane(link.url)
      } else if (e.key === 'a' && !link.archiveIs && !link.excluded) {
        e.preventDefault()
        void capture(link.url, 'archiveIs')
      } else if (e.key === 'd' && !link.localPath && !link.excluded) {
        e.preventDefault()
        void capture(link.url, 'local')
      } else if (e.key === 'x') {
        e.preventDefault()
        void toggleExcluded(link.url, !link.excluded)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /** Menu items post actions here; the renderer owns the state to carry them out. */
  useEffect(() => {
    return window.backfile.onMenuAction((action) => {
      switch (action) {
        case 'open-workspace':
          return void chooseWorkspace()
        case 'analyze':
          return void analyze()
        case 'publish':
          return void openPublishPreview()
        case 'capture-all-archive':
          return void captureAll('archiveIs')
        case 'capture-all-local':
          return void captureAll('local')
        case 'stop-capture':
          return void window.backfile.cancelCapture()
        case 'reveal-article':
          if (selected) void window.backfile.revealArticle(selected.path)
          return
        case 'focus-search':
          searchRef.current?.focus()
          searchRef.current?.select()
          return
        case 'toggle-sidebar':
          return setSidebarOpen(!sidebarOpen)
        case 'toggle-detail':
          return setDetailOpen(!detailOpen)
        case 'toggle-browser':
          return setPaneOpen(!paneOpen)
        case 'theme-system':
          return setTheme('system')
        case 'theme-light':
          return setTheme('light')
        case 'theme-dark':
          return setTheme('dark')
        case 'support-email':
          return void window.backfile.supportEmail(
            selected ? `article "${selected.name}"` : ''
          )
      }
    })
  })

  const openInPane = useCallback((url: string) => {
    setPaneOpen(true)
    void window.backfile.browserOpen(url)
  }, [])

  const openExternal = useCallback((url: string) => {
    void window.backfile.openExternal(url)
  }, [])

  const openLocal = useCallback(
    (relativePath: string) => {
      if (selected) void window.backfile.openCapture(selected.path, relativePath)
    },
    [selected]
  )

  const viewLocal = useCallback(
    async (relativePath: string) => {
      if (!selected) return
      setPaneOpen(true)
      const opened = await window.backfile.viewCapture(selected.path, relativePath)
      if (!opened) setStatus('That capture file is missing from disk.')
    },
    [selected]
  )

  const revealLocal = useCallback(
    (relativePath: string) => {
      if (selected) void window.backfile.revealCapture(selected.path, relativePath)
    },
    [selected]
  )

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">Backfile</div>
        <div className="titlebar-actions">
          <button
            className="btn btn-quiet"
            title="Support Backfile — opens Buy Me a Coffee in your browser"
            onClick={() => openExternal('https://buymeacoffee.com/zacharysedefian')}
          >
            ♥ Donate
          </button>
          <button
            className="btn btn-quiet"
            title="Backfile is open source — view it on GitHub"
            onClick={() => openExternal('https://github.com/zbsedefian/backfile')}
          >
            Source
          </button>
          <button
            className="btn btn-quiet"
            title="Email a question to the author. Opens your mail app — Backfile has no server, so it cannot send mail itself."
            onClick={() =>
              window.backfile.supportEmail(selected ? `article "${selected.name}"` : '')
            }
          >
            Help
          </button>
          <button
            className="icon-toggle"
            title={`Theme: ${theme}. Click to cycle system → light → dark.`}
            onClick={() =>
              setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')
            }
          >
            {theme === 'light' ? '☀' : theme === 'dark' ? '☾' : '◐'}
          </button>
          <button
            className={`icon-toggle${sidebarOpen ? ' is-on' : ''}`}
            title="Toggle the articles panel"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            ▤
          </button>
          <button
            className={`icon-toggle${detailOpen ? ' is-on' : ''}`}
            title="Toggle the detail panel"
            onClick={() => setDetailOpen(!detailOpen)}
          >
            ▥
          </button>
        </div>
      </header>

      <div
        className="body"
        style={{
          gridTemplateColumns: [
            sidebarOpen ? `${sidebarWidth}px` : '0px',
            sidebarOpen ? '5px' : '0px',
            'minmax(0, 1fr)',
            detailOpen ? '5px' : '0px',
            detailOpen ? `${detailWidth}px` : '0px'
          ].join(' ')
        }}
      >
        {sidebarOpen ? (
          <Sidebar
            root={root}
            articles={articles}
            selected={selected}
            hidden={hidden}
            onSelect={(a) => {
              setSelectedPath(a.path)
              setSelectedUrl(null)
            }}
            onChooseWorkspace={chooseWorkspace}
            onSetHidden={updateHidden}
            onCreateCollection={createCollection}
            onReveal={(p) => window.backfile.revealArticle(p)}
          />
        ) : (
          <div />
        )}

        {sidebarOpen ? (
          <ResizeHandle
            orientation="vertical"
            onDelta={(d) => setSidebarWidth(clamp(sidebarWidth + d, 180, 460))}
            onDoubleClick={() => setSidebarOpen(false)}
          />
        ) : (
          <div />
        )}

        <main className="main">
          {selected ? (
            <>
              <div className="main-head">
                <div className="main-head-info">
                  <h1 className="article-title">{selected.name}</h1>
                  {counts && (
                    <div className="counts">
                      <span className="count count-gold">★ {counts.gold} full</span>
                      <span className="count count-silver">★ {counts.silver} archive.is</span>
                      <span className="count count-bronze">★ {counts.bronze} local</span>
                      <span className="count count-none">○ {counts.none} none</span>
                      {counts.excluded > 0 && (
                        <span className="count muted">— {counts.excluded} excluded</span>
                      )}
                    </div>
                  )}
                </div>
                <div className="head-controls">
                  <input
                    ref={searchRef}
                    className="input search"
                    placeholder="Search sources…  ( / )"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <div className="filters">
                    {(['all', 'unsecured', 'secured'] as Filter[]).map((f) => (
                      <button
                        key={f}
                        className={`tab${filter === f ? ' is-active' : ''}`}
                        onClick={() => setFilter(f)}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="toolbar">
                <button
                  className="btn btn-primary"
                  onClick={() => setAddingSource(true)}
                  title="Save a link to this collection by hand"
                >
                  + Add link
                </button>
                <button
                  className="btn"
                  onClick={analyze}
                  disabled={analyzing || !!batch || selected.documents.length === 0}
                  title={
                    selected.documents.length === 0
                      ? 'No documents in this folder to read links from'
                      : 'Read every link out of the documents in this folder'
                  }
                >
                  {analyzing ? 'Analyzing\u2026' : 'Analyze links'}
                </button>

                <span className="toolbar-divider" />

                {batch ? (
                  <button className="btn btn-danger" onClick={() => window.backfile.cancelCapture()}>
                    Stop capturing
                  </button>
                ) : (
                  <CaptureMenu
                    pending={{ ...pendingCounts, video: videoPending }}
                    videoAvailable={videoAvailable}
                    disabled={analyzing}
                    onRun={captureAll}
                  />
                )}

                <button
                  className="btn btn-quiet"
                  onClick={refreshWorkspace}
                  title="Re-scan the folder for collections added outside Backfile"
                >
                  Refresh
                </button>

                <span className="toolbar-sep" />

                {docxDocuments.length > 0 && (
                  <div className="publish-group">
                    <select
                      className="select"
                      value={publishTarget}
                      onChange={(e) => setPublishTarget(e.target.value)}
                      title="Which draft to republish"
                    >
                      {docxDocuments.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn"
                      onClick={openPublishPreview}
                      disabled={publishing || !publishTarget}
                      title="Preview a copy of this draft with every cited link repointed at its archive snapshot. The original is not modified."
                    >
                      Publish archived copy\u2026
                    </button>
                  </div>
                )}
              </div>

              <SourceTable
                links={visible}
                selectedUrl={selectedUrl}
                busy={busy}
                query={query}
                sort={sort}
                onSortChange={setSort}
                onSelect={setSelectedUrl}
                onCapture={capture}
                onOpen={openInPane}
                onOpenExternal={openExternal}
                onOpenLocal={openLocal}
              />

              {paneOpen && tabs.length > 0 && (
                <>
                  <ResizeHandle
                    orientation="horizontal"
                    onDelta={(d) =>
                      setBrowserHeight(
                        clamp(browserHeight - d, 160, Math.max(220, window.innerHeight - 260))
                      )
                    }
                    onDoubleClick={() => setPaneOpen(false)}
                  />
                  <BrowserPanel
                    tabs={tabs}
                    height={browserHeight}
                    onClose={() => setPaneOpen(false)}
                  />
                </>
              )}
            </>
          ) : (
            <div className="empty-state">
              <h1 className="article-title">No article selected</h1>
              <p className="muted">
                Pick an article on the left, then run “Analyze links”. Backfile reads .docx drafts
                (including footnotes) and plain .txt link lists.
              </p>
            </div>
          )}
        </main>

        {detailOpen ? (
          <ResizeHandle
            orientation="vertical"
            onDelta={(d) => setDetailWidth(clamp(detailWidth - d, 220, 520))}
            onDoubleClick={() => setDetailOpen(false)}
          />
        ) : (
          <div />
        )}

        {detailOpen ? (
          <DetailPane
            link={selected?.sources.find((l) => l.url === selectedUrl) ?? null}
            articlePath={selected?.path ?? ''}
            onToggleExcluded={toggleExcluded}
            onOpen={openInPane}
            onOpenExternal={openExternal}
            onOpenLocal={openLocal}
            onViewLocal={viewLocal}
            onRevealLocal={revealLocal}
            onEditUrl={editSourceUrl}
            onDelete={deleteSource}
          />
        ) : (
          <div />
        )}
      </div>

      {batch && (
        <div className={`batchbar${batch.needsHuman ? ' needs-human' : ''}`}>
          <div className="batchbar-track">
            <div
              className="batchbar-fill"
              style={{
                width: batch.total ? `${Math.round((batch.done / batch.total) * 100)}%` : '0%'
              }}
            />
          </div>
          <span className="small batchbar-label">
            {batch.needsHuman
              ? 'Stuck or waiting on a CAPTCHA — finish it in the pane, or skip it.'
              : `${batch.done} of ${batch.total}`}
            {batch.url && <span className="muted"> · {batch.url}</span>}
          </span>
          <div className="batchbar-actions">
            {batch.url && (
              <button
                className="chip"
                title="Open the stuck source in a new tab so you can see what happened"
                onClick={() => openInPane(batch.url)}
              >
                Show it
              </button>
            )}
            <button
              className="chip"
              title="Give up on this one and move to the next source"
              onClick={() => window.backfile.skipCapture()}
            >
              Skip
            </button>
            <button className="chip" onClick={() => window.backfile.cancelCapture()}>
              Stop all
            </button>
          </div>
        </div>
      )}

      {addingSource && selected && (
        <AddSourceDialog
          articleName={selected.name}
          saving={savingSource}
          onSave={saveNewSource}
          onCancel={() => setAddingSource(false)}
        />
      )}

      {plan && (
        <PublishPreview
          plan={plan}
          writing={publishing}
          onConfirm={publish}
          onCancel={() => setPlan(null)}
        />
      )}

      <footer className="statusbar">
        <span className="mono small">{status}</span>
        <span className="statusbar-hint small muted">
          ↑↓ move · ⏎ open · a archive.is · d download · x exclude · / search
        </span>
      </footer>
    </div>
  )
}
