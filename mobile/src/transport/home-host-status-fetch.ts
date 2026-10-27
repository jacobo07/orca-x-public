import { sendSingleFlightRequest } from './request-single-flight'
import type { RpcClient } from './rpc-client'
import { isLogicalClientCutoverError } from './stable-logical-rpc-client'

// Why: a relay↔direct cutover rejects the in-flight read without leaving 'connected'; re-ask on
// the replacement session, capped so a migration loop cannot spin (as home-host-worktree-fetch).
const CUTOVER_RETRY_LIMIT = 2

export type HomeHostStatusSnapshot = { observedAt: number; result: unknown }

export type HomeHostStatusSetter = (
  updater: (prev: Record<string, HomeHostStatusSnapshot>) => Record<string, HomeHostStatusSnapshot>
) => void

/** Reads one host's status.get for the Home card; a failed read keeps the previous answer. */
export function fetchHomeHostStatus(
  client: RpcClient,
  hostId: string,
  setStatus: HomeHostStatusSetter,
  disposed: () => boolean
): Promise<void> {
  const attempt = (cutoverRetriesLeft: number): Promise<void> =>
    sendSingleFlightRequest(client, hostId, 'status.get', undefined)
      .then((response) => {
        // Why keep on !ok: an old answer is judged stale by the presenter, never deleted.
        if (disposed() || !response.ok) {
          return
        }
        const snapshot: HomeHostStatusSnapshot = { observedAt: Date.now(), result: response.result }
        setStatus((prev) => ({ ...prev, [hostId]: snapshot }))
      })
      .catch((error: unknown) => {
        if (disposed()) {
          return
        }
        if (cutoverRetriesLeft > 0 && isLogicalClientCutoverError(error)) {
          return attempt(cutoverRetriesLeft - 1)
        }
      })

  return attempt(CUTOVER_RETRY_LIMIT)
}
