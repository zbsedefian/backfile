/**
 * Multi-row selection with modifier keys.
 *
 * This lives outside the component because the interesting part is the anchor.
 * A shift-click extends from wherever the last plain or cmd click landed rather
 * than from whichever row is currently focused, which is what lets a run of
 * shift-clicks widen and narrow the same range instead of walking off down the
 * table one row at a time.
 */

/** Cmd on macOS, Ctrl elsewhere. */
export interface ClickModifiers {
  /** Add or remove this one row, leaving the rest alone. */
  toggle: boolean
  /** Take everything between the anchor and this row. */
  range: boolean
}

export interface Selection {
  /** Every selected url, always in the order the list currently shows them. */
  urls: string[]
  /** The row the detail pane follows and the single-row shortcuts act on. */
  focus: string | null
  /** Where a shift-range measures from. */
  anchor: string | null
}

export const EMPTY_SELECTION: Selection = { urls: [], focus: null, anchor: null }

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** Inclusive span between two rows, in either direction. */
function span(list: string[], from: string, to: string): string[] {
  const i = list.indexOf(from)
  const j = list.indexOf(to)
  if (i === -1 || j === -1) return []
  return i <= j ? list.slice(i, j + 1) : list.slice(j, i + 1)
}

function inListOrder(list: string[], urls: Set<string>): string[] {
  return list.filter((u) => urls.has(u))
}

/** A plain click: this row and nothing else. */
export function selectOne(url: string): Selection {
  return { urls: [url], focus: url, anchor: url }
}

export function applyClick(
  list: string[],
  current: Selection,
  url: string,
  mods: ClickModifiers
): Selection {
  if (mods.range && current.anchor) {
    const range = span(list, current.anchor, url)
    // A stale anchor — its row filtered away since the last click — falls
    // through to a plain click rather than selecting nothing.
    if (range.length > 0) return { urls: range, focus: url, anchor: current.anchor }
  }

  if (mods.toggle) {
    const next = new Set(current.urls)
    if (next.delete(url)) {
      const urls = inListOrder(list, next)
      // Deselecting the focused row hands focus to whatever is still selected,
      // so the detail pane keeps showing something the user picked.
      const focus = current.focus === url ? (urls[urls.length - 1] ?? null) : current.focus
      return { urls, focus, anchor: url }
    }
    next.add(url)
    return { urls: inListOrder(list, next), focus: url, anchor: url }
  }

  return selectOne(url)
}

/**
 * Arrow-key movement. Shift extends the range from the anchor; a bare arrow
 * abandons the selection and starts a new one, the way a text cursor does.
 */
export function applyArrow(
  list: string[],
  current: Selection,
  step: 1 | -1,
  extend: boolean
): Selection {
  if (list.length === 0) return EMPTY_SELECTION

  const at = current.focus ? list.indexOf(current.focus) : -1
  // From no selection, Down starts at the top and Up starts at the bottom.
  const next = at === -1 ? (step === 1 ? 0 : list.length - 1) : clamp(at + step, 0, list.length - 1)
  const url = list[next]

  if (!extend) return selectOne(url)
  const anchor = current.anchor ?? current.focus ?? url
  return { urls: span(list, anchor, url), focus: url, anchor }
}

export function selectAll(list: string[]): Selection {
  if (list.length === 0) return EMPTY_SELECTION
  return { urls: [...list], focus: list[list.length - 1], anchor: list[0] }
}

/**
 * Drop rows the list no longer contains — a filter change, a search, a removal,
 * a different article. Returns the selection unchanged when nothing was lost,
 * so this is safe to run on every list change without churning state.
 */
export function reconcile(list: string[], current: Selection): Selection {
  if (current.urls.length === 0 && current.focus === null) return current

  const present = new Set(list)
  const urls = current.urls.filter((u) => present.has(u))
  const focus = current.focus && present.has(current.focus) ? current.focus : (urls[urls.length - 1] ?? null)
  const anchor = current.anchor && present.has(current.anchor) ? current.anchor : focus

  if (urls.length === current.urls.length && focus === current.focus && anchor === current.anchor) {
    return current
  }
  return { urls, focus, anchor }
}
