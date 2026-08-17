/**
 * Feature flags, checked from both the main process and the renderer.
 *
 * A flat map rather than a scattered `if` in every call site, so putting a
 * feature behind a paid tier later is a one-line change here — flip the
 * value, or wire it to a real license check — instead of a hunt through main
 * and renderer code for everywhere it needs to be gated.
 */
export const FEATURES = {
  /** Link-rot checking. Free today; the flag a paid tier will switch off. */
  linkHealth: true
} as const
