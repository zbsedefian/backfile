import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RewritePlan } from '../main/docx/rewriteLinks'
import type { Article, ArchiveTier, ServiceId, SourceLink } from '../shared/types'
import { isStranded, linkOutcome, ownSources, tierOf } from '../shared/types'
import { FEATURES } from '../shared/features'
import {
  EMPTY_SELECTION,
  applyArrow,
  applyClick,
  reconcile,
  selectAll,
  selectOne,
  type ClickModifiers,
  type Selection
} from '../shared/selection'
import type { TabInfo } from '../main/browser/BrowserPane'
import { Sidebar } from './components/Sidebar'
import { SourceTable, busyKey, filterLinks, sortLinks, type Sort } from './components/SourceTable'
import { DetailPane } from './components/DetailPane'
import { BrowserPanel } from './components/BrowserPanel'
import { PublishPreview } from './components/PublishPreview'
import { AddSourceDialog } from './components/AddSourceDialog'
import { FailuresPanel } from './components/FailuresPanel'
import { CaptureMenu } from './components/CaptureMenu'
import { ArticleSourceMenu } from './components/ArticleSourceMenu'
import { ResizeHandle } from './components/ResizeHandle'
import { EvidenceDialog } from './components/EvidenceDialog'
import { VerifyPanel } from './components/VerifyPanel'
import { tierCounts } from './components/Tier'
import { clamp, usePersistentState } from './usePersistentState'
import type { VerificationReport } from '../main/evidence/manifest'
import type { TimestampMode } from '../main/evidence/timestamp'
import { DEFAULT_TSA_URL } from '../shared/evidence'

/**
 * What the source list is narrowed to.
 *
 * Mirrors the tier vocabulary exactly (gold/silver/bronze/none/excluded) so the
 * filter and the tier counts shown next to it are the same control — see the
 * note above the filter bar in the JSX below for why that used to be two.
 */
type Filter = 'all' | ArchiveTier | 'excluded' | 'orphaned' | 'notfound' | 'unverified'

const SERVICE_LABEL: Record<ServiceId, string> = {
  archiveIs: 'archive.is',
  wayback: 'Wayback',
  local: 'Local',
  video: 'Video'
}

/**
 * A failure worth keeping around.
 *
 * The status bar shows one line at a time, so a batch of twenty captures with
 * three failures scattered through it leaves only the last one visible by the
 * time the run finishes — the other two are gone the moment the next status
 * message overwrites them. This is the record that survives.
 */
export interface CaptureFailure {
  id: string
  source: ServiceId | 'analyze' | 'publish'
  url?: string
  message: string
  at: string
}

export function App(): JSX.Element {
  const [root, setRoot] = useState<string | null>(null)
  const [articles, setArticles] = useState<Article[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION)
  const selectedUrl = selection.focus
  /** Collapse to a single row, or to nothing. Most callers want this. */
  const setSelectedUrl = useCallback((url: string | null) => {
    setSelection(url === null ? EMPTY_SELECTION : selectOne(url))
  }, [])
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [filter, setFilter] = useState<Filter>('all')
  /** Narrows the list to one imported document's sources; null shows every article. */
  const [sourceFilter, setSourceFilter] = useState<string | null>(null)

  // The document filter names a file in one project. Carried across a project
  // switch it silently filters the next project's list down to nothing — the
  // dropdown still shows the old filename, and the table reports "no sources"
  // for a folder that has plenty.
  useEffect(() => {
    setSourceFilter(null)
  }, [selectedPath])
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
  /** The export modal is open before a target — and so a plan — exists. */
  const [exportOpen, setExportOpen] = useState(false)
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
  const [sourceColWidth, setSourceColWidth] = usePersistentState('layout.sourceCol', 300)
  interface RunState {
    done: number
    total: number
    needsHuman: boolean
    url: string
  }
  // Keyed by service: archive.is, Wayback and local copies can run at once, so
  // one shared progress slot would have them overwriting each other's numbers.
  const [runs, setRuns] = useState<Partial<Record<ServiceId, RunState>>>({})
  const anyRunning = Object.keys(runs).length > 0

  // Mirrors `batch` in a ref so the workspace watcher can check it without
  // re-subscribing every time progress ticks.
  const batchRef = useRef(false)
  useEffect(() => {
    batchRef.current = anyRunning
  }, [anyRunning])

  const selected = useMemo(
    () => articles.find((a) => a.path === selectedPath) ?? null,
    [articles, selectedPath]
  )

  // Only a draft can be republished with archived links — a reference document
  // in the same folder is not yours to rewrite.
  const docxDocuments = useMemo(
    () => selected?.drafts.filter((d) => d.toLowerCase().endsWith('.docx')) ?? [],
    [selected]
  )

  /**
   * Exporting never assumes which document you mean. A project can hold more
   * than one imported .docx — a draft and a later revision, say — and silently
   * defaulting to whichever was imported first is exactly how the wrong one
   * gets exported without anyone noticing. The picker inside the modal starts
   * empty and the Export button stays disabled until something is explicitly
   * chosen there.
   *
   * The exception is a target that has become invalid — removed via the ×, or
   * the project switched out from under it — which is cleared, along with any
   * plan already read for it, rather than left pointing at a document that no
   * longer exists.
   */
  useEffect(() => {
    if (publishTarget && !docxDocuments.includes(publishTarget)) {
      setPublishTarget('')
      setPlan(null)
    }
    // publishTarget is deliberately absent: this only reacts to the available
    // documents changing, not to a fresh choice made from inside the modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const [failures, setFailures] = useState<CaptureFailure[]>([])
  const [failuresOpen, setFailuresOpen] = useState(false)
  const failuresRef = useRef<CaptureFailure[]>([])
  useEffect(() => {
    failuresRef.current = failures
  }, [failures])

  // ---- evidence: timestamping settings, manifest verification, capture reports ----
  const [evidenceDialogOpen, setEvidenceDialogOpen] = useState(false)
  const [tsaUrl, setTsaUrl] = useState(DEFAULT_TSA_URL)
  const [savingTsaUrl, setSavingTsaUrl] = useState(false)
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyReport, setVerifyReport] = useState<VerificationReport | null>(null)
  const [generatingReport, setGeneratingReport] = useState(false)

  /**
   * Add a failure to the running record.
   *
   * Opens the panel the moment the list goes from empty to non-empty, so a
   * fresh problem is surfaced rather than left for the journalist to notice on
   * their own — but does not force it back open on every subsequent failure,
   * or reviewing three lines while a nine-source batch keeps running would mean
   * fighting the panel for the rest of the run.
   */
  const recordFailure = useCallback(
    (source: CaptureFailure['source'], message: string, url?: string) => {
      const wasEmpty = failuresRef.current.length === 0
      setFailures((prev) => [
        ...prev,
        { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, source, url, message, at: new Date().toISOString() }
      ])
      if (wasEmpty) setFailuresOpen(true)
    },
    []
  )

  /** Replace one article in place so the sidebar counts stay live. */
  const patchArticle = useCallback((articlePath: string, sources: SourceLink[]) => {
    setArticles((prev) =>
      prev.map((a) => (a.path === articlePath ? { ...a, sources, hasSourcesFile: true } : a))
    )
  }, [])

  /**
   * Re-reads sources.csv and patches it into state, coalescing overlapping
   * calls into one trailing read instead of firing one per caller.
   *
   * Local captures run four at a time, so without this, a burst of finishing
   * downloads would each kick off their own readSources call racing the
   * others — wasted reads, and up to four redundant re-renders for work that
   * one read already covers. writeSources itself is write-then-rename, so an
   * overlapping read is never at risk of seeing a half-written file; this is
   * purely about not doing the same read four times over.
   */
  const sourcesRefresh = useRef<{ busy: boolean; pending: string | null }>({
    busy: false,
    pending: null
  })
  const refreshSources = useCallback(
    async (articlePath: string) => {
      const state = sourcesRefresh.current
      if (state.busy) {
        // Remember which path was asked for, not just that something was: a
        // refresh for project B arriving while project A's is in flight must
        // not be satisfied by re-reading A.
        state.pending = articlePath
        return
      }
      state.busy = true
      let target: string | null = articlePath
      try {
        while (target) {
          state.pending = null
          const sources = await window.backfile.readSources(target)
          patchArticle(target, sources)
          target = state.pending
        }
      } finally {
        state.busy = false
      }
    },
    [patchArticle]
  )

  /**
   * Import a document into this article.
   *
   * The file picker is aimed at the folder itself, but Electron has no way to
   * actually confine it there — the journalist can still browse anywhere on
   * disk — so a pick from outside the folder is rejected on the main-process
   * side rather than silently accepted and quietly broken later.
   *
   * Importing is additive and immediate: the document joins whatever was
   * already imported, and analysis re-runs over the whole accumulated set right
   * away, so the newly imported file's links show up without a second click.
   * Nothing about re-importing an already-imported file is destructive either —
   * it just re-reads it.
   */
  const addArticle = useCallback(async () => {
    if (!selected) return
    let picked: string
    try {
      picked = await window.backfile.pickDocument(selected.path)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus(`Could not import: ${message}`)
      recordFailure('analyze', message)
      return
    }
    if (!picked) return // Cancelled.

    const alreadyImported = selected.drafts.includes(picked)
    const nextDrafts = alreadyImported ? selected.drafts : [...selected.drafts, picked]

    setAnalyzing(true)
    setStatus(`Importing ${picked}…`)
    try {
      // Analysis first, then the record of it. Analysis is what writes
      // sources.csv, and a stored import is only believed while that file is
      // there — so recording first leaves a window where a rescan sees an
      // import with nothing to show for it and clears it away. This order also
      // means a document that fails to parse is not left sitting in the
      // switcher as though it had been imported.
      const result = await window.backfile.analyzeArticle(selected.path, nextDrafts)
      if (!alreadyImported) {
        await window.backfile.setDrafts(selected.path, selected.documents, nextDrafts)
        setArticles((prev) =>
          prev.map((a) => (a.path === selected.path ? { ...a, drafts: nextDrafts } : a))
        )
      }
      patchArticle(selected.path, result.links)
      const bits = [`Imported ${picked}`, `${result.links.length} sources`]
      if (result.added) bits.push(`${result.added} new`)
      if (result.imported) bits.push(`${result.imported} snapshots imported`)
      if (result.updated) bits.push(`${result.updated} updated`)
      setStatus(bits.join(' · '))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus(`Import failed: ${message}`)
      recordFailure('analyze', message, picked)
    } finally {
      setAnalyzing(false)
    }
  }, [selected, patchArticle, recordFailure])

  /**
   * Undo an import. The only correction available for a mistaken pick, since
   * "Add article" never asks twice before reading a file — so it has to exist,
   * or picking the wrong document by accident has no way back except editing
   * Backfile's settings file by hand.
   */
  const removeArticle = useCallback(
    async (name: string) => {
      if (!selected) return
      const nextDrafts = selected.drafts.filter((d) => d !== name)
      setAnalyzing(true)
      setStatus(`Removing ${name}…`)
      try {
        setArticles((prev) =>
          prev.map((a) => (a.path === selected.path ? { ...a, drafts: nextDrafts } : a))
        )
        await window.backfile.setDrafts(selected.path, selected.documents, nextDrafts)
        const result = await window.backfile.analyzeArticle(selected.path, nextDrafts)
        patchArticle(selected.path, result.links)
        setStatus(`Removed ${name}. Its sources are still in sources.csv, under “orphaned”.`)
        if (sourceFilter === name) setSourceFilter(null)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setStatus(`Could not remove ${name}: ${message}`)
        recordFailure('analyze', message, name)
      } finally {
        setAnalyzing(false)
      }
    },
    [selected, patchArticle, recordFailure, sourceFilter]
  )

  const capture = useCallback(
    async (url: string, service: ServiceId) => {
      if (!selected) return
      const key = busyKey(url, service)
      setBusy((b) => ({ ...b, [key]: true }))
      // The status points at the pane, so the pane had better be visible —
      // a CAPTCHA waiting in a hidden pane looks exactly like a hang.
      if (service === 'archiveIs') setPaneOpen(true)
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
        // Cancelling is something the journalist asked for, not a failure.
        if (!result.ok && result.error !== 'cancelled') {
          recordFailure(service, result.error ?? 'unknown error', url)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setStatus(`Failed: ${message}`)
        recordFailure(service, message, url)
      } finally {
        setBusy((b) => {
          const next = { ...b }
          delete next[key]
          return next
        })
      }
    },
    [selected, patchArticle, recordFailure]
  )

  /** Stream progress into a per-service row. */
  useEffect(() => {
    return window.backfile.onCaptureProgress((p) => {
      if (p.phase === 'finished') {
        setRuns((prev) => {
          const next = { ...prev }
          delete next[p.service]
          return next
        })
        setStatus(
          p.detail === 'Stopped.'
            ? `${p.service}: stopped — ${p.succeeded ?? 0} captured.`
            : `${p.service}: done. ${p.succeeded ?? 0} captured${
                p.failed ? `, ${p.failed} failed` : ''
              }.`
        )
        if (selectedPath) void refreshSources(selectedPath)
        return
      }

      setRuns((prev) => ({
        ...prev,
        [p.service]: {
          done: p.done,
          total: p.total,
          needsHuman: p.phase === 'needs-human',
          url: p.url
        }
      }))

      if (p.phase === 'needs-human') {
        // The message points at the pane, so the pane had better be visible.
        setPaneOpen(true)
        setStatus(p.detail ?? 'Waiting for you…')
      } else if (p.phase === 'saved') {
        setStatus(`${p.done}/${p.total} · saved ${p.detail}`)
        // Each finished capture updates its own row immediately — a batch of
        // twenty used to look completely idle until all twenty were done,
        // with nothing in the table itself hinting that work was happening.
        if (selectedPath) void refreshSources(selectedPath)
      } else if (p.phase === 'failed') {
        setStatus(`${p.done}/${p.total} · failed: ${p.detail}`)
        recordFailure(p.service, p.detail ?? 'unknown error', p.url)
        if (selectedPath) void refreshSources(selectedPath)
      }
    })
  }, [selectedPath, refreshSources, recordFailure])

  const [checkingLinks, setCheckingLinks] = useState(false)

  useEffect(() => {
    return window.backfile.onLinkCheckProgress((p) => {
      if (p.phase === 'finished') {
        setStatus(
          p.detail === 'Stopped.'
            ? `Link check stopped — ${p.checked ?? 0} checked.`
            : `Link check done: ${p.checked ?? 0} checked, ${p.flagged ?? 0} flagged.`
        )
        if (selectedPath) void refreshSources(selectedPath)
        return
      }
      if (p.phase === 'checked') {
        setStatus(`${p.done}/${p.total} · checked ${p.url}`)
        if (selectedPath) void refreshSources(selectedPath)
      }
    })
  }, [selectedPath, refreshSources])

  /**
   * Run one service over the whole article, or over `urls` when a selection
   * narrows it. Either way it goes through the batch runner rather than a loop
   * of single captures: that is what holds one archive.is session open across
   * the queue and keeps the request pacing in one place.
   */
  const captureAll = useCallback(
    async (service: ServiceId, urls?: string[]) => {
      if (!selected) return
      setRuns((prev) => ({
        ...prev,
        [service]: { done: 0, total: 0, needsHuman: false, url: '' }
      }))
      // archive.is runs in the pane, so make sure the journalist can see it.
      if (service === 'archiveIs') setPaneOpen(true)
      try {
        await window.backfile.captureAll(selected.path, service, urls)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setStatus(`${service}: ${message}`)
        recordFailure(service, message)
        setRuns((prev) => {
          const next = { ...prev }
          delete next[service]
          return next
        })
      } finally {
        // The progress stream already refreshes on every finished capture and
        // again when the run reports 'finished'; this is a final backstop for
        // outcomes that never reach the progress stream at all, such as the
        // batch call itself throwing before a single source was attempted.
        await refreshSources(selected.path)
      }
    },
    [selected, refreshSources, recordFailure]
  )

  /**
   * Opens the modal with nothing chosen yet — the article picker lives at its
   * top rather than out on the toolbar, since picking one is the first
   * decision this whole action turns on, not a setting to leave configured
   * beforehand and risk forgetting.
   */
  const openExport = useCallback(() => {
    setPublishTarget('')
    setPlan(null)
    setExportOpen(true)
  }, [])

  const closeExport = useCallback(() => {
    setExportOpen(false)
    setPlan(null)
    setPublishTarget('')
  }, [])

  const selectExportTarget = useCallback(
    async (name: string) => {
      setPublishTarget(name)
      setPlan(null)
      if (!selected || !name) return
      try {
        setPlan(await window.backfile.planRewrite(selected.path, name))
      } catch (err) {
        setStatus(`Could not read ${name}: ${err instanceof Error ? err.message : err}`)
        recordFailure('publish', err instanceof Error ? err.message : String(err), name)
      }
    },
    [selected, recordFailure]
  )

  const publish = useCallback(async () => {
    if (!selected || !publishTarget) return
    setPublishing(true)
    try {
      const result = await window.backfile.rewriteDocx(selected.path, publishTarget)
      closeExport()
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
      const message = err instanceof Error ? err.message : String(err)
      setStatus(`Publish failed: ${message}`)
      recordFailure('publish', message, publishTarget)
    } finally {
      setPublishing(false)
    }
  }, [selected, publishTarget, recordFailure, closeExport])

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

  const editSourceTitle = useCallback(
    async (url: string, title: string) => {
      if (!selected) return
      const next = selected.sources.map((l) => (l.url === url ? { ...l, title } : l))
      patchArticle(selected.path, next)
      await window.backfile.saveSources(selected.path, next)
    },
    [selected, patchArticle]
  )

  const [recapturing, setRecapturing] = useState<string | null>(null)

  /** Discard a recorded capture and immediately redo it. */
  const recapture = useCallback(
    async (url: string, service: ServiceId) => {
      if (!selected) return
      setRecapturing(service)
      try {
        const cleared = await window.backfile.clearCapture(selected.path, url, service)
        patchArticle(selected.path, cleared)
        await capture(url, service)
      } finally {
        setRecapturing(null)
      }
    },
    [selected, patchArticle, capture]
  )

  const [confirmingBulk, setConfirmingBulk] = useState(false)

  /** Remove everything currently listed. Only offered from the orphaned view. */
  const removeShown = useCallback(async () => {
    if (!selected) return
    const urls = visibleRef.current.map((l) => l.url)
    const links = await window.backfile.removeSources(selected.path, urls)
    patchArticle(selected.path, links)
    setSelectedUrl(null)
    setConfirmingBulk(false)
    setStatus(`Removed ${urls.length} source${urls.length === 1 ? '' : 's'}.`)
  }, [selected, patchArticle])

  /**
   * A human looked at the source themselves and it's fine — clears the flag
   * without waiting on another automated check. That matters most for
   * `unverified`: the same bot wall that produced it will just as likely
   * trip the same way on the next automated check, forever, so the only way
   * out is a person saying so.
   */
  const resolveLinkCheck = useCallback(
    async (url: string) => {
      if (!selected) return
      const next = selected.sources.map((l) =>
        l.url === url
          ? {
              ...l,
              linkStatus: 'ok' as const,
              lastCheckedAt: new Date().toISOString().slice(0, 19).replace('T', ' ')
            }
          : l
      )
      patchArticle(selected.path, next)
      await window.backfile.saveSources(selected.path, next)
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

  /**
   * Sources that came in through a document no longer ticked as a draft.
   *
   * Unticking has to take effect at once rather than at the next analysis: the
   * whole point of saying "this is not my draft" is to stop looking at its
   * links, and leaving forty of them in the list until you remember to
   * re-analyse is not stopping. Nothing is deleted — the rows and their
   * snapshots stay in sources.csv, and re-ticking brings them straight back.
   *
   * A source cited by a ticked draft *and* an unticked one stays: it is a real
   * citation that happens to also appear elsewhere.
   */
  const stranded = useMemo(() => {
    if (!selected) return new Set<string>()
    return new Set(
      selected.sources.filter((l) => isStranded(l, selected.drafts)).map((l) => l.url)
    )
  }, [selected])

  /** Everything this article still claims as its own, whatever the filter. */
  const articleSources = useMemo(
    () => (selected ? ownSources(selected) : []),
    [selected]
  )

  /**
   * "Capture all" means all of *this article's* sources. The batch otherwise
   * reads sources.csv straight off disk, which still holds the rows an unticked
   * document brought in — and archiving those is exactly what unticking it was
   * meant to prevent.
   */
  const captureArticle = useCallback(
    (service: ServiceId) => {
      void captureAll(
        service,
        articleSources.map((l) => l.url)
      )
    },
    [captureAll, articleSources]
  )

  /** "Check links" means all of *this article's* sources — same reasoning as captureArticle above. */
  const checkLinks = useCallback(async () => {
    if (!selected) return
    setCheckingLinks(true)
    setStatus('Checking links…')
    try {
      await window.backfile.checkLinks(
        selected.path,
        articleSources.map((l) => l.url)
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus(`Could not check links: ${message}`)
    } finally {
      setCheckingLinks(false)
    }
  }, [selected, articleSources])

  const shown = useMemo(() => {
    if (!selected) return []
    const byFilter = selected.sources.filter((l) => {
      // Which imported document this row belongs to is independent of its
      // archival status, so it narrows the list before any of the tier logic
      // below even runs.
      if (sourceFilter && !l.articleSource.includes(sourceFilter)) return false
      // Orphans are kept on purpose — a cut sentence is not a reason to discard
      // evidence — but they need to be findable to be cleaned up when they are
      // genuinely junk. Sources stranded by unticking a document land here too:
      // hidden from the working views, still reachable for removal.
      if (filter === 'orphaned') return l.foundIn.length === 0 || stranded.has(l.url)
      // Same reasoning as orphaned: a flagged link is kept findable for
      // cleanup even if the document citing it has since been unticked.
      if (filter === 'notfound') return linkOutcome(l) === 'gone'
      if (filter === 'unverified') return linkOutcome(l) === 'unverified'
      if (stranded.has(l.url)) return false
      if (filter === 'all') return true
      // Same precedence as tierCounts below: excluded is checked before tier,
      // because tierOf reports an excluded link as gold to keep it out of the
      // "needs work" tiers — but that must not make it show up under "full".
      if (filter === 'excluded') return l.excluded
      if (l.excluded) return false
      return tierOf(l) === filter
    })
    return filterLinks(byFilter, query)
  }, [selected, filter, query, stranded, sourceFilter])

  /**
   * The row order, held still.
   *
   * Sorting by tier and re-running it on every change means each finished
   * capture promotes its own row and pushes every other one down — under a
   * cursor that is halfway through the list. So the order is recomputed only
   * when the journalist changes what they are looking at, or when the set of
   * rows itself changes, and a capture that merely upgrades a row leaves it
   * exactly where it was.
   */
  const rowSet = useMemo(() => [...shown.map((l) => l.url)].sort().join('\n'), [shown])
  const [order, setOrder] = useState<string[]>([])
  useEffect(() => {
    setOrder(sortLinks(shown, sort).map((l) => l.url))
    // `shown` is deliberately absent: it changes identity on every capture, and
    // rowSet is what says whether the rows themselves changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, filter, query, sort, rowSet])

  const visible = useMemo(() => {
    const byUrl = new Map(shown.map((l) => [l.url, l]))
    const ordered = order.map((u) => byUrl.get(u)).filter((l): l is SourceLink => l !== undefined)
    // Before the effect above has run for a new list, fall back to sorting now,
    // so the first paint is never an empty table.
    return ordered.length === shown.length ? ordered : sortLinks(shown, sort)
  }, [shown, order, sort])

  // Mirrors the filtered list so the bulk action can read it without being
  // declared after it.
  const visibleRef = useRef<SourceLink[]>([])
  useEffect(() => {
    visibleRef.current = visible
  }, [visible])

  const visibleUrls = useMemo(() => visible.map((l) => l.url), [visible])

  /**
   * Why the table is empty, when the default copy would get it wrong.
   *
   * The trap case is a folder whose sources.csv has plenty of rows but no
   * document imported — a colleague's shared folder, or one analysed before
   * importing became explicit. Every analysed row is hidden as belonging to
   * an unimported document, and "No sources recorded yet" would be a lie that
   * sends someone hunting for a data-loss bug instead of a button.
   */
  const emptyHint = useMemo(() => {
    if (!selected || visible.length !== 0 || query) return undefined
    if (selected.sources.length > 0 && selected.drafts.length === 0 && filter === 'all') {
      const n = selected.sources.length
      return (
        `This folder's sources.csv already lists ${n} source${n === 1 ? '' : 's'}, but no ` +
        'document has been imported here yet, so they are hidden from the working view. ' +
        'Press "Add article" to import the document they came from — or find them under ' +
        'the Orphaned filter.'
      )
    }
    if (sourceFilter) {
      return `No sources from ${sourceFilter} match this view. Switch the dropdown back to "All articles" to widen it.`
    }
    return undefined
  }, [selected, visible, query, filter, sourceFilter])

  // Rows can leave the list under the selection — a filter change, a search, a
  // removal — and acting on a url that is no longer shown is how a bulk action
  // surprises someone.
  useEffect(() => {
    setSelection((current) => reconcile(visibleUrls, current))
  }, [visibleUrls])

  const selectAt = useCallback(
    (url: string, mods: ClickModifiers) => {
      setSelection((current) => applyClick(visibleUrls, current, url, mods))
    },
    [visibleUrls]
  )

  /** The selected rows themselves, in list order. */
  const selectedLinks = useMemo(() => {
    const chosen = new Set(selection.urls)
    return visible.filter((l) => chosen.has(l.url))
  }, [visible, selection])

  const multi = selection.urls.length > 1

  /**
   * Mark every selected row as needing an archive, or as not needing one. The
   * button follows the majority so a mixed selection resolves in one click
   * instead of flipping each row to the opposite of where it started.
   */
  const excludeSelected = useCallback(
    async (excluded: boolean) => {
      if (!selected || selection.urls.length === 0) return
      const chosen = new Set(selection.urls)
      const next = selected.sources.map((l) =>
        chosen.has(l.url)
          ? {
              ...l,
              excluded,
              excludedReason: excluded ? l.excludedReason || 'marked by hand' : ''
            }
          : l
      )
      patchArticle(selected.path, next)
      await window.backfile.saveSources(selected.path, next)
      setStatus(
        `${chosen.size} source${chosen.size === 1 ? '' : 's'} marked as ${
          excluded ? 'needing no archive' : 'needing an archive'
        }.`
      )
    },
    [selected, selection, patchArticle]
  )

  const [confirmingRemoveSelected, setConfirmingRemoveSelected] = useState(false)

  const removeSelected = useCallback(async () => {
    if (!selected || selection.urls.length === 0) return
    const count = selection.urls.length
    const links = await window.backfile.removeSources(selected.path, selection.urls)
    patchArticle(selected.path, links)
    setSelection(EMPTY_SELECTION)
    setConfirmingRemoveSelected(false)
    setStatus(`Removed ${count} source${count === 1 ? '' : 's'}. Captured files stay on disk.`)
  }, [selected, selection, patchArticle])

  // A fresh selection should not inherit the last one's armed confirmation.
  useEffect(() => {
    setConfirmingRemoveSelected(false)
  }, [selection])

  /** How many of the selected rows still owe this service a capture. */
  const selectedPending = useCallback(
    (field: 'archiveIs' | 'wayback' | 'localPath' | 'videoPath'): string[] =>
      selectedLinks.filter((l) => !l.excluded && !l[field]).map((l) => l.url),
    [selectedLinks]
  )

  const captureSelected = useCallback(
    (service: ServiceId, field: 'archiveIs' | 'wayback' | 'localPath' | 'videoPath') => {
      const urls = selectedPending(field)
      if (urls.length === 0) {
        setStatus(`Every selected source already has a ${SERVICE_LABEL[service]} capture.`)
        return
      }
      void captureAll(service, urls)
    },
    [selectedPending, captureAll]
  )

  const mostlyExcluded = useMemo(
    () => selectedLinks.filter((l) => l.excluded).length * 2 > selectedLinks.length,
    [selectedLinks]
  )

  const counts = useMemo(
    () => (selected ? tierCounts(articleSources) : null),
    [selected, articleSources]
  )

  const notFoundCount = useMemo(
    () => (selected ? articleSources.filter((l) => linkOutcome(l) === 'gone').length : 0),
    [selected, articleSources]
  )
  const unverifiedCount = useMemo(
    () => (selected ? articleSources.filter((l) => linkOutcome(l) === 'unverified').length : 0),
    [selected, articleSources]
  )

  /**
   * How many sources each service still owes, so the buttons can say so.
   *
   * Counted over the article's own sources, so a document you have unticked
   * stops contributing work — otherwise "Capture all" would cheerfully go and
   * archive forty links belonging to somebody else's article.
   */
  const pendingCounts = useMemo(() => {
    const outstanding = (field: 'archiveIs' | 'wayback' | 'localPath' | 'videoPath'): number =>
      articleSources.filter((l) => !l.excluded && !l[field]).length
    return {
      archiveIs: outstanding('archiveIs'),
      wayback: outstanding('wayback'),
      local: outstanding('localPath')
    }
  }, [articleSources])

  /**
   * Sources still missing a video download. There is no reliable way to know
   * in advance which pages actually have a video — yt-dlp recognises well
   * over a thousand sites, on hosts as unpredictable as x.com where most
   * links are plain text and some are video — so this counts every
   * uncaptured source rather than guessing from the URL, and a source that
   * turns out to have no video just fails quickly.
   */
  const videoPending = useMemo(
    () => articleSources.filter((l) => !l.excluded && !l.videoPath).length,
    [articleSources]
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
   * Whether yt-dlp may use a real, logged-in browser session — set from the
   * Capture menu, since it is a statement about this machine, not this
   * article. Off (null) means an age-gated or sign-in-required video simply
   * fails, which is the account-free default everything else in Backfile
   * keeps to.
   */
  const setVideoCookiesBrowser = useCallback(async (browser: string | null) => {
    await window.backfile.setVideoCookiesBrowser(browser)
    setStatus(
      browser
        ? `Video downloads may now use your ${browser} login when a video needs one.`
        : 'Video downloads will no longer use a signed-in browser session.'
    )
  }, [])

  /**
   * Which timestamping scheme, if any, a local or video capture's SHA-256 is
   * submitted to — set from the Evidence menu. Off by default; see
   * evidence/timestamp.ts for why that default is deliberate.
   */
  const setTimestampMode = useCallback(async (mode: TimestampMode) => {
    const current = await window.backfile.timestampSettings()
    await window.backfile.setTimestampSettings({ mode, tsaUrl: current.tsaUrl })
    setStatus(
      mode === 'off'
        ? 'Timestamping is off — captures are no longer submitted anywhere.'
        : mode === 'opentimestamps'
          ? 'Captures will be timestamped with OpenTimestamps (free, anchored in Bitcoin).'
          : `Captures will be timestamped via ${current.tsaUrl || DEFAULT_TSA_URL}.`
    )
  }, [])

  const openEvidenceDialog = useCallback(async () => {
    const current = await window.backfile.timestampSettings()
    setTsaUrl(current.tsaUrl || DEFAULT_TSA_URL)
    setEvidenceDialogOpen(true)
  }, [])

  const saveTsaUrl = useCallback(async (url: string) => {
    setSavingTsaUrl(true)
    try {
      await window.backfile.setTimestampSettings({ mode: 'rfc3161', tsaUrl: url })
      setStatus(`Timestamping via ${url}.`)
      setEvidenceDialogOpen(false)
    } finally {
      setSavingTsaUrl(false)
    }
  }, [])

  /**
   * Bring the manifest up to date with whatever is on disk. Never overwrites a
   * recorded hash — see evidence/manifest.ts — so this is always safe to run.
   */
  const refreshManifest = useCallback(async () => {
    if (!selected) return
    setStatus('Updating manifest…')
    try {
      const result = await window.backfile.refreshManifest(selected.path)
      setStatus(
        result.added > 0
          ? `Manifest updated — ${result.added} capture${result.added === 1 ? '' : 's'} added.`
          : 'Manifest already matches the captures on disk.'
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus(`Could not update the manifest: ${message}`)
    }
  }, [selected])

  const runVerify = useCallback(async () => {
    if (!selected) return
    setVerifyOpen(true)
    setVerifying(true)
    try {
      const report = await window.backfile.verifyCaptures(selected.path)
      setVerifyReport(report)
    } catch (err) {
      setVerifyOpen(false)
      recordFailure('analyze', err instanceof Error ? err.message : String(err))
    } finally {
      setVerifying(false)
    }
  }, [selected, recordFailure])

  /** A printable, self-explanatory record of one source, for attaching to a filing. */
  const generateReport = useCallback(
    async (url: string) => {
      if (!selected) return
      setGeneratingReport(true)
      setStatus('Generating capture report…')
      try {
        const result = await window.backfile.generateCaptureReport(selected.path, url)
        if (result.ok) {
          setStatus(`Report saved — ${result.path}`)
          void window.backfile.revealCapture(selected.path, result.path)
        } else {
          setStatus(`Could not generate the report: ${result.error}`)
        }
      } finally {
        setGeneratingReport(false)
      }
    },
    [selected]
  )

  /**
   * Fetches yt-dlp's own binary, for a journalist who has never opened a
   * terminal. "brew install yt-dlp" is a dead end for that audience — this
   * only asks them to click a button they can already see.
   */
  const [ytdlpInstalling, setYtdlpInstalling] = useState(false)
  const [ytdlpProgress, setYtdlpProgress] = useState<{
    receivedBytes: number
    totalBytes: number | null
  } | null>(null)

  useEffect(() => window.backfile.onYtDlpInstallProgress(setYtdlpProgress), [])

  const installYtDlp = useCallback(async () => {
    setYtdlpInstalling(true)
    setYtdlpProgress(null)
    setStatus('Downloading yt-dlp from GitHub…')
    try {
      const result = await window.backfile.installYtDlp()
      if (result.ok) {
        setVideoAvailable(true)
        setStatus('yt-dlp installed — video downloads are ready.')
      } else {
        setStatus(`Could not install yt-dlp: ${result.error}`)
        recordFailure('video', result.error)
      }
    } finally {
      setYtdlpInstalling(false)
      setYtdlpProgress(null)
    }
  }, [recordFailure])

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
        if (failuresOpen) return setFailuresOpen(false)
        if (verifyOpen) return setVerifyOpen(false)
        if (evidenceDialogOpen) return setEvidenceDialogOpen(false)
        if (addingSource) return setAddingSource(false)
        if (exportOpen) return closeExport()
        if (typing) return (target as HTMLElement).blur()
        if (query) return setQuery('')
        // Escape narrows a multi-selection back to the focused row before it
        // gives up and clears, so it never throws away more than one step.
        if (multi && selectedUrl) return setSelectedUrl(selectedUrl)
        if (selectedUrl) return setSelectedUrl(null)
        return
      }

      if ((e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key === 'f')) && !typing) {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }

      // With any modal up, the table underneath is not what the keyboard is
      // aimed at — a, d and x firing captures on hidden rows is how a review
      // of three failures quietly launches a fourth capture.
      if (typing || exportOpen || addingSource || failuresOpen || verifyOpen || evidenceDialogOpen)
        return

      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        if (visible.length === 0) return
        e.preventDefault()
        setSelection(selectAll(visibleUrls))
        return
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (visible.length === 0) return
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        // Shift extends the range instead of starting a new selection.
        const next = applyArrow(visibleUrls, selection, step, e.shiftKey)
        setSelection(next)
        if (next.focus) {
          document
            .querySelector(`[data-url="${CSS.escape(next.focus)}"]`)
            ?.scrollIntoView({ block: 'nearest' })
        }
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
      } else if (e.key === 'a' && (multi || (!link.archiveIs && !link.excluded))) {
        e.preventDefault()
        // With several rows selected the shortcuts act on all of them, so a
        // range picked with shift can be captured without touching the mouse.
        if (multi) captureSelected('archiveIs', 'archiveIs')
        else void capture(link.url, 'archiveIs')
      } else if (e.key === 'd' && (multi || (!link.localPath && !link.excluded))) {
        e.preventDefault()
        if (multi) captureSelected('local', 'localPath')
        else void capture(link.url, 'local')
      } else if (e.key === 'x') {
        e.preventDefault()
        if (multi) void excludeSelected(!mostlyExcluded)
        else void toggleExcluded(link.url, !link.excluded)
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
        case 'add-article':
          return void addArticle()
        case 'publish':
          return openExport()
        case 'capture-all-archive':
          return captureArticle('archiveIs')
        case 'capture-all-local':
          return captureArticle('local')
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
        case 'video-cookies-off':
          return void setVideoCookiesBrowser(null)
        case 'video-cookies-chrome':
          return void setVideoCookiesBrowser('chrome')
        case 'video-cookies-safari':
          return void setVideoCookiesBrowser('safari')
        case 'video-cookies-firefox':
          return void setVideoCookiesBrowser('firefox')
        case 'video-cookies-edge':
          return void setVideoCookiesBrowser('edge')
        case 'video-cookies-brave':
          return void setVideoCookiesBrowser('brave')
        case 'evidence-refresh-manifest':
          return void refreshManifest()
        case 'evidence-verify':
          return void runVerify()
        case 'evidence-timestamp-off':
          return void setTimestampMode('off')
        case 'evidence-timestamp-opentimestamps':
          return void setTimestampMode('opentimestamps')
        case 'evidence-timestamp-rfc3161':
          return void setTimestampMode('rfc3161')
        case 'evidence-configure-tsa':
          return void openEvidenceDialog()
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
                <div className="main-head-top">
                  <h1 className="article-title">{selected.name}</h1>
                  {/*
                    Importing decides what counts as this article's own
                    material in the first place — a decision made once per
                    document, not a per-source working action — so it sits with
                    the title, right-justified, rather than down in the toolbar
                    among the capture buttons reached for constantly.
                  */}
                  <div className="main-head-actions">
                    <button
                      className="btn"
                      onClick={addArticle}
                      disabled={analyzing}
                      title="Import a document from this folder and read its links"
                    >
                      {analyzing ? 'Importing…' : 'Add article'}
                    </button>
                  </div>
                </div>

                <div className="main-head-bottom">
                  {/*
                    The tier counts ARE the filter, not a caption next to one.
                    They used to be plain text sitting right above a separate
                    row of All/Unsecured/Secured/Orphaned tabs — same shape,
                    same position, and inert, so clicking a count (the natural
                    thing to try) did nothing while the tabs below it, doing
                    the same job, did. One control now, and it shows its own
                    counts on its own buttons.
                  */}
                  {counts && (
                    <div className="filters">
                      <button
                        className={`tab${filter === 'all' ? ' is-active' : ''}`}
                        onClick={() => setFilter('all')}
                        title="Every source belonging to an imported document, whatever its archival status"
                      >
                        All
                      </button>
                      <button
                        className={`count-btn count-gold${filter === 'gold' ? ' is-active' : ''}`}
                        onClick={() => setFilter('gold')}
                        title="Fully archived: an archive.is snapshot, a Wayback snapshot, and a local copy — nothing left to do"
                      >
                        ★ {counts.gold} full
                      </button>
                      <button
                        className={`count-btn count-silver${filter === 'silver' ? ' is-active' : ''}`}
                        onClick={() => setFilter('silver')}
                        title="Has an archive.is snapshot — the one that matters most for a citation — but not yet a local copy or a Wayback backup"
                      >
                        ★ {counts.silver} archive.is
                      </button>
                      <button
                        className={`count-btn count-bronze${filter === 'bronze' ? ' is-active' : ''}`}
                        onClick={() => setFilter('bronze')}
                        title="Only a local copy so far — no archive.is snapshot yet, which is usually the next thing worth doing"
                      >
                        ★ {counts.bronze} local
                      </button>
                      <button
                        className={`count-btn count-none${filter === 'none' ? ' is-active' : ''}`}
                        onClick={() => setFilter('none')}
                        title="Not archived at all yet"
                      >
                        ○ {counts.none} none
                      </button>
                      {counts.excluded > 0 && (
                        <button
                          className={`count-btn muted${filter === 'excluded' ? ' is-active' : ''}`}
                          onClick={() => setFilter('excluded')}
                          title="Marked as not needing an archive — a DOI or repository link that already resolves permanently, or marked so by hand"
                        >
                          — {counts.excluded} excluded
                        </button>
                      )}
                      <button
                        className={`tab${filter === 'orphaned' ? ' is-active' : ''}`}
                        onClick={() => setFilter('orphaned')}
                        title="No longer cited by any imported document — cut from a later draft, or belonging to one that was removed. Kept on purpose: nothing here is deleted until you say so"
                      >
                        Orphaned
                      </button>
                      {FEATURES.linkHealth && notFoundCount > 0 && (
                        <button
                          className={`tab${filter === 'notfound' ? ' is-active' : ''}`}
                          onClick={() => setFilter('notfound')}
                          title="The original URL now returns 404 — the server itself says the page is gone"
                        >
                          Not found ({notFoundCount})
                        </button>
                      )}
                      {FEATURES.linkHealth && unverifiedCount > 0 && (
                        <button
                          className={`tab${filter === 'unverified' ? ' is-active' : ''}`}
                          onClick={() => setFilter('unverified')}
                          title="The last link check could not confirm this page resolves — could be real link rot, could just be a bot-detection wall"
                        >
                          Unverified ({unverifiedCount})
                        </button>
                      )}
                    </div>
                  )}

                  <div className="head-controls">
                    <input
                      ref={searchRef}
                      className="input search"
                      placeholder="Search sources…  ( / )"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    {filter === 'orphaned' && visible.length > 0 && (
                      confirmingBulk ? (
                        <span className="bulk-confirm">
                          <button className="btn btn-danger" onClick={removeShown}>
                            Remove {visible.length}
                          </button>
                          <button className="btn btn-quiet" onClick={() => setConfirmingBulk(false)}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          className="btn btn-quiet"
                          title="Remove every source shown here. Captured files stay on disk."
                          onClick={() => setConfirmingBulk(true)}
                        >
                          Remove all {visible.length} shown
                        </button>
                      )
                    )}
                  </div>
                </div>
              </div>

              {/*
                The selection actions take over the toolbar rather than opening
                a bar of their own. A new bar would push the table down the
                moment a second row was picked — the list jumping under a cursor
                that is mid-shift-click is how you lose your place in it — and
                floating the bar over the table would hide rows instead.
              */}
              <div className={`toolbar${multi ? ' is-selecting' : ''}`}>
                {multi ? (
                  <>
                    <span className="selection-count">{selection.urls.length} selected</span>

                    <button
                      className="btn btn-quiet"
                      disabled={analyzing}
                      onClick={() => captureSelected('archiveIs', 'archiveIs')}
                      title="Capture the selected sources to archive.is"
                    >
                      Capture archive.is
                    </button>
                    <button
                      className="btn btn-quiet"
                      disabled={analyzing}
                      onClick={() => captureSelected('local', 'localPath')}
                      title="Save a local copy of each selected source"
                    >
                      Download local
                    </button>
                    <button
                      className="btn btn-quiet"
                      disabled={analyzing}
                      onClick={() => captureSelected('wayback', 'wayback')}
                      title="Submit the selected sources to the Wayback Machine"
                    >
                      Wayback
                    </button>
                    <button
                      className="btn btn-quiet"
                      disabled={analyzing}
                      onClick={() => captureSelected('video', 'videoPath')}
                      title="Download the actual video file for each selected source, if it has one. Needs yt-dlp."
                    >
                      Download video
                    </button>

                    <span className="toolbar-divider" />

                    <button
                      className="btn btn-quiet"
                      onClick={() => void excludeSelected(!mostlyExcluded)}
                      title="Mark the selected sources as needing no archive"
                    >
                      {mostlyExcluded ? 'Needs archiving' : "Doesn't need archiving"}
                    </button>

                    {confirmingRemoveSelected ? (
                      <span className="bulk-confirm">
                        <button className="btn btn-danger" onClick={removeSelected}>
                          Remove {selection.urls.length}
                        </button>
                        <button
                          className="btn btn-quiet"
                          onClick={() => setConfirmingRemoveSelected(false)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        className="btn btn-quiet"
                        title="Remove the selected sources from sources.csv. Captured files stay on disk."
                        onClick={() => setConfirmingRemoveSelected(true)}
                      >
                        Remove…
                      </button>
                    )}

                    {/* Stays reachable in either mode — a run in progress must
                        always be stoppable, selection or no selection. */}
                    {anyRunning && (
                      <button
                        className="btn btn-danger"
                        onClick={() => window.backfile.cancelCapture()}
                      >
                        Stop all
                      </button>
                    )}

                    <button
                      className="btn btn-quiet selection-clear"
                      onClick={() => setSelectedUrl(selection.focus)}
                      title="Back to a single row (Esc)"
                    >
                      Clear
                    </button>
                  </>
                ) : (
                <>
                <ArticleSourceMenu
                  articles={selected.drafts}
                  value={sourceFilter}
                  onChange={setSourceFilter}
                  onRemove={removeArticle}
                />

                <button
                  className="btn btn-primary"
                  onClick={() => setAddingSource(true)}
                  title="Save a link to this collection by hand"
                >
                  + Add link
                </button>

                <span className="toolbar-divider" />

                <CaptureMenu
                  pending={{ ...pendingCounts, video: videoPending }}
                  videoAvailable={videoAvailable}
                  disabled={analyzing}
                  running={Object.keys(runs) as ServiceId[]}
                  onRun={captureArticle}
                  onInstallYtDlp={installYtDlp}
                  installingYtDlp={ytdlpInstalling}
                  installProgress={ytdlpProgress}
                />
                {anyRunning && (
                  <button
                    className="btn btn-danger"
                    onClick={() => window.backfile.cancelCapture()}
                  >
                    Stop all
                  </button>
                )}

                {FEATURES.linkHealth && (
                  checkingLinks ? (
                    <button
                      className="btn btn-danger"
                      onClick={() => selected && void window.backfile.cancelLinkCheck(selected.path)}
                    >
                      Stop check
                    </button>
                  ) : (
                    <button
                      className="btn"
                      disabled={analyzing || articleSources.length === 0}
                      onClick={() => void checkLinks()}
                      title="Request every source's original URL and record whether it still resolves"
                    >
                      Check links
                    </button>
                  )
                )}

                <span className="toolbar-divider" />

                {docxDocuments.length > 0 && (
                  <button
                    className="btn"
                    onClick={openExport}
                    title="Choose an article and preview its links repointed at their archive snapshots. The original is not modified."
                  >
                    Export…
                  </button>
                )}

                {/*
                  Rescanning for folders added outside Backfile is upkeep, not
                  a step in the normal workflow — an icon earns it a place
                  without competing with the buttons reached for constantly.
                */}
                <button
                  className="icon-toggle toolbar-icon"
                  onClick={refreshWorkspace}
                  title="Re-scan the folder for collections added outside Backfile"
                >
                  ⟳
                </button>
                </>
                )}
              </div>

              <SourceTable
                links={visible}
                selectedUrls={selection.urls}
                focusedUrl={selection.focus}
                busy={busy}
                query={query}
                sort={sort}
                onSortChange={setSort}
                onSelect={selectAt}
                onCapture={capture}
                onOpen={openInPane}
                onOpenExternal={openExternal}
                onViewLocal={viewLocal}
                onOpenLocal={openLocal}
                onResolveLinkCheck={resolveLinkCheck}
                emptyHint={emptyHint}
                sourceColWidth={sourceColWidth}
                onSourceColWidthChange={(w) => setSourceColWidth(clamp(w, 200, 720))}
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
              {root ? (
                <>
                  <h1 className="article-title">No project selected</h1>
                  <p className="muted">
                    Pick a project on the left, then press “Add article” to import a document.
                    Backfile reads .docx drafts (including footnotes), Google Docs exports, and
                    plain .txt link lists.
                  </p>
                </>
              ) : (
                <>
                  <h1 className="article-title">Welcome to Backfile</h1>
                  <p className="muted">
                    Start by choosing the folder where you keep your projects — one subfolder per
                    piece of journalism, with the drafts inside. Use “Open folder…” at the top
                    left.
                  </p>
                  <p className="muted">
                    Everything Backfile records lives in a plain{' '}
                    <span className="mono">sources.csv</span> inside each project's own folder —
                    no hidden database, no account, nothing that only Backfile can read. It opens
                    in Excel, it works with whatever backup or sync you already use, and your work
                    stays exactly where you can find it even if you never open this app again.
                  </p>
                </>
              )}
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
            drafts={selected?.drafts ?? []}
            onToggleExcluded={toggleExcluded}
            onOpen={openInPane}
            onOpenExternal={openExternal}
            onOpenLocal={openLocal}
            onViewLocal={viewLocal}
            onRevealLocal={revealLocal}
            onEditUrl={editSourceUrl}
            onEditTitle={editSourceTitle}
            onDelete={deleteSource}
            onRecapture={recapture}
            recapturing={recapturing}
            onGenerateReport={generateReport}
            generatingReport={generatingReport}
          />
        ) : (
          <div />
        )}
      </div>

      {Object.entries(runs).map(([service, run]) => (
        <div key={service} className={`batchbar${run.needsHuman ? ' needs-human' : ''}`}>
          <span className="batchbar-service">{SERVICE_LABEL[service as ServiceId]}</span>
          <div className="batchbar-track">
            <div
              className="batchbar-fill"
              style={{
                width: run.total ? `${Math.round((run.done / run.total) * 100)}%` : '0%'
              }}
            />
          </div>
          <span className="small batchbar-label">
            {run.needsHuman
              ? 'Stuck or waiting on a CAPTCHA — finish it in the pane, or skip it.'
              : `${run.done} of ${run.total}`}
            {run.url && <span className="muted"> · {run.url}</span>}
          </span>
          <div className="batchbar-actions">
            {run.url && (
              <button className="chip" onClick={() => openInPane(run.url)}>
                Show it
              </button>
            )}
            {service === 'archiveIs' && (
              <button
                className="chip"
                title="Give up on this one and move to the next source"
                onClick={() => window.backfile.skipCapture(service as ServiceId)}
              >
                Skip
              </button>
            )}
            <button
              className="chip"
              onClick={() => window.backfile.cancelCapture(service as ServiceId)}
            >
              Stop
            </button>
          </div>
        </div>
      ))}

      {addingSource && selected && (
        <AddSourceDialog
          articleName={selected.name}
          saving={savingSource}
          onSave={saveNewSource}
          onCancel={() => setAddingSource(false)}
        />
      )}

      {exportOpen && (
        <PublishPreview
          documents={docxDocuments}
          target={publishTarget}
          onSelectTarget={selectExportTarget}
          plan={plan}
          writing={publishing}
          onConfirm={publish}
          onCancel={closeExport}
        />
      )}

      <footer className="statusbar">
        <span className="mono small">{status}</span>
        {failures.length > 0 && (
          <button className="failure-badge" onClick={() => setFailuresOpen(true)}>
            {failures.length} failure{failures.length === 1 ? '' : 's'}
          </button>
        )}
        <span className="statusbar-hint small muted">
          ↑↓ move · ⏎ open · a archive.is · d download · x exclude · / search
        </span>
      </footer>

      {failuresOpen && (
        <FailuresPanel
          failures={failures}
          onClose={() => setFailuresOpen(false)}
          onClear={() => {
            setFailures([])
            setFailuresOpen(false)
          }}
        />
      )}

      {evidenceDialogOpen && (
        <EvidenceDialog
          currentUrl={tsaUrl}
          saving={savingTsaUrl}
          onSave={saveTsaUrl}
          onCancel={() => setEvidenceDialogOpen(false)}
        />
      )}

      {verifyOpen && (
        <VerifyPanel
          report={verifyReport}
          checking={verifying}
          onClose={() => setVerifyOpen(false)}
          onRecheck={runVerify}
        />
      )}
    </div>
  )
}
