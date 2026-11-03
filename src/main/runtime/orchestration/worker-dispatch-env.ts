/**
 * ORCA_WORKER_DISPATCH_ID marks the terminal Orca creates for a supervised worker, so a
 * user-level hook can tell worker sessions from the user's own (for example to refuse
 * `git push` inside workers). Not a security boundary: a process can unset its own variable.
 *
 * The value is stamped only from the trusted creation path (the worker-start code that just
 * wrote the dispatch row). Every PTY env path calls enforceWorkerDispatchIdEnv, which removes
 * an inherited or caller-supplied value that the runtime did not mint.
 */
export const WORKER_DISPATCH_ID_ENV = 'ORCA_WORKER_DISPATCH_ID'

// Why bounded and not released after spawn: a renderer-backed startup terminal can spawn after
// the create call returns, and releasing early would silently leave that worker untagged.
const MAX_TRUSTED_DISPATCH_IDS = 1000

const trustedDispatchIds = new Set<string>()

export function trustWorkerDispatchId(dispatchId: string): void {
  trustedDispatchIds.delete(dispatchId)
  trustedDispatchIds.add(dispatchId)
  while (trustedDispatchIds.size > MAX_TRUSTED_DISPATCH_IDS) {
    const oldest = trustedDispatchIds.values().next().value as string
    trustedDispatchIds.delete(oldest)
  }
}

export function isTrustedWorkerDispatchId(value: string | undefined): boolean {
  return typeof value === 'string' && trustedDispatchIds.has(value)
}

/** Env for a worker terminal's creation: trusts the id and returns the variable to merge. */
export function workerDispatchTerminalEnv(dispatchId: string): Record<string, string> {
  trustWorkerDispatchId(dispatchId)
  return { [WORKER_DISPATCH_ID_ENV]: dispatchId }
}

/**
 * Removes the variable in place unless its value is a dispatch id this runtime minted.
 * Returns true when the variable must also be deleted from an env the spawner merges later
 * (a daemon or relay that inherited it from its own parent).
 */
export function enforceWorkerDispatchIdEnv(env: Record<string, string | undefined>): boolean {
  if (isTrustedWorkerDispatchId(env[WORKER_DISPATCH_ID_ENV])) {
    return false
  }
  delete env[WORKER_DISPATCH_ID_ENV]
  return true
}

export function resetTrustedWorkerDispatchIdsForTest(): void {
  trustedDispatchIds.clear()
}
