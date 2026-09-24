/**
 * Bounds for work shared across requests in one Workers isolate.
 *
 * A single-flight promise is shared by every request that needs the same
 * result, but its I/O belongs to the request that started it. If that request
 * is cancelled or ends, the runtime may cancel its subrequest, and a promise
 * the other requests are awaiting may never settle. So every provider fetch is
 * bounded, and every waiter bounds its own wait with a timer created in its
 * own request, then decides for itself what to do if the shared work does not
 * finish.
 */

/** Upper bound on one call to WorkOS: a key-set fetch or a token exchange. */
export const PROVIDER_FETCH_TIMEOUT_MS = 5_000

export type Settled<T> = { settled: true; value: T } | { settled: false }

/** Waits for `work` for at most `ms`, on a timer owned by the caller. */
export function settleWithin<T>(
  work: Promise<T>,
  ms: number,
): Promise<Settled<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ settled: false }), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve({ settled: true, value })
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
