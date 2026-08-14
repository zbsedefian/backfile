import { useEffect, useState } from 'react'

/**
 * State that survives a restart.
 *
 * Pane sizes are muscle memory: having them reset every launch is the kind of
 * small daily friction that makes a tool feel disposable. localStorage is the
 * right home for this rather than settings.json — it is window chrome, not
 * archival data, and nothing here is worth putting in a user's file tree.
 */
export function usePersistentState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key)
      return stored === null ? initial : (JSON.parse(stored) as T)
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // A full or disabled localStorage must never break the layout.
    }
  }, [key, value])

  return [value, setValue]
}

/** Clamp a dragged dimension so a pane can never be dragged out of existence. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
