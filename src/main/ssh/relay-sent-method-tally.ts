// E2E-only count of the JSON-RPC methods this process sends to SSH relays, read by specs through
// electronApp.evaluate. A relay never logs request methods (an old relay never will), so absence of a
// gated method is only provable at the client's own write. Off unless ORCA_E2E_RELAY_METHOD_TALLY=1.

export const RELAY_SENT_METHOD_TALLY_KEY = '__orcaRelaySentMethods'

type TallyGlobal = { [RELAY_SENT_METHOD_TALLY_KEY]?: Record<string, number> }

const enabled = process.env.ORCA_E2E_RELAY_METHOD_TALLY === '1'

export function tallyRelaySentMethod(method: string | undefined): void {
  if (!enabled || method === undefined) {
    return
  }
  const g = globalThis as TallyGlobal
  const tally = (g[RELAY_SENT_METHOD_TALLY_KEY] ??= {})
  tally[method] = (tally[method] ?? 0) + 1
}

export function relaySentMethodTallyEnabled(): boolean {
  return enabled
}
