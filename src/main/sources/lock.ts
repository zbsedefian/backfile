/**
 * Serialised access to a collection's sources.csv.
 *
 * Every mutation is read-modify-write over a whole file. That was safe while
 * captures ran strictly one at a time, and stopped being safe the moment local
 * downloads were allowed to run four abreast: two workers finishing together
 * would each read the same rows, and the second write would silently discard
 * the first one's snapshot. A lost record is the worst failure available here,
 * because nothing reports it — the capture succeeded, the file just forgot.
 *
 * A promise chain per file is enough. There is exactly one process writing, so
 * this only has to order work, not guard against other applications.
 */

const chains = new Map<string, Promise<unknown>>()

/**
 * Run `work` with exclusive access to `key`, queued behind anything already
 * running for that key. A failure does not poison the queue for later callers.
 */
export function withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve()

  // Run regardless of whether the predecessor resolved or rejected.
  const result = previous.then(work, work)

  // The chain tracks completion only, never the value or the failure.
  const settled = result.then(
    () => undefined,
    () => undefined
  )
  chains.set(key, settled)

  // Once this is the tail and it has settled, forget the key so a long session
  // does not retain a resolved promise for every collection ever touched.
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key)
  })

  return result
}
