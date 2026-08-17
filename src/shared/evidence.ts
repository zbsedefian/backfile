/**
 * Evidence-layer constants shared between the main process and the renderer.
 *
 * Kept apart from src/main/evidence/timestamp.ts on purpose: that module pulls
 * in Node's crypto and fetch to actually talk to a timestamp authority, which
 * has no business being bundled into the renderer just so a settings dialog
 * can show a placeholder URL.
 */

/** A free, publicly documented RFC 3161 authority, used until someone picks their own. */
export const DEFAULT_TSA_URL = 'https://freetsa.org/tsr'
