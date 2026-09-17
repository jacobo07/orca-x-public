/**
 * How to ask one runtime host a question it cannot answer twice at once.
 *
 * A host refreshes its PTY inventory under a single generation counter per runtime, so a
 * fresh listing overlapped by a later one is failed closed — pinned against the real
 * service in src/main/runtime/terminal-list-fresh-liveness-overlap.test.ts. This module
 * owns that contract and nothing else: it does not decide eligibility, orphanhood, or
 * what to display, and it never serves one caller's answer to another. Serialization is
 * not caching — every caller still runs its own request when its turn comes, so a
 * destructive re-check stays as fresh as it was before it was queued.
 *
 * Hosts are independent: one unresponsive host delays only its own queue.
 */

const tailByEnvironmentId = new Map<string, Promise<void>>()

function settlesBefore(previous: Promise<void>, deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()))
    void previous.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * Runs `run` once this host is free, or answers `null` if `deadline` passes first.
 * `null` means "could not ask" — never "the host said no".
 */
export function runOnRuntimeHost<T>(
  environmentId: string,
  deadline: number,
  run: () => Promise<T>
): Promise<T | null> {
  const previous = tailByEnvironmentId.get(environmentId) ?? Promise.resolve()
  const result = settlesBefore(previous, deadline).then((ready) => (ready ? run() : null))
  // Why: a caller that gave up waiting must not shorten the queue for the next one. The
  // host is still busy with `previous`, so the tail has to outlive both — chaining only
  // this caller's result would let the caller after it overlap the request still running.
  const tail = Promise.all([
    previous,
    result.then(
      () => undefined,
      () => undefined
    )
  ]).then(() => undefined)
  tailByEnvironmentId.set(environmentId, tail)
  void tail.then(() => {
    if (tailByEnvironmentId.get(environmentId) === tail) {
      tailByEnvironmentId.delete(environmentId)
    }
  })
  return result
}

export function resetRuntimeHostQueueForTests(): void {
  tailByEnvironmentId.clear()
}
