const outputEpochByPaneKey = new Map<string, number>()

export function recordAgentHibernationPaneOutput(paneKey: string): void {
  if (!paneKey) {
    return
  }
  outputEpochByPaneKey.set(paneKey, getAgentHibernationPaneOutputEpoch(paneKey) + 1)
}

export function getAgentHibernationPaneOutputEpoch(paneKey: string): number {
  return outputEpochByPaneKey.get(paneKey) ?? 0
}

// Why: this module-level map gains an entry per pane that ever emits PTY output
// and is keyed by `tabId:leafId` (leafId is a fresh UUID each open), so without
// an explicit purge on permanent pane removal it grows for the renderer's whole
// lifetime. A reopened pane starts at epoch 0 — identical to never-seen — so
// dropping a closed pane's entry is safe.
export function forgetAgentHibernationPaneOutput(paneKey: string): void {
  outputEpochByPaneKey.delete(paneKey)
}

// Why: tab and worktree teardown remove every pane under a `tabId:` prefix at
// once; mirror that bulk shape so callers don't re-implement the key scan.
export function forgetAgentHibernationTabOutput(tabId: string): void {
  const prefix = `${tabId}:`
  for (const paneKey of outputEpochByPaneKey.keys()) {
    if (paneKey.startsWith(prefix)) {
      outputEpochByPaneKey.delete(paneKey)
    }
  }
}

export function getAgentHibernationOutputSignature(paneKeys: readonly string[]): string {
  return paneKeys
    .slice()
    .sort()
    .map((paneKey) => `${paneKey}:${getAgentHibernationPaneOutputEpoch(paneKey)}`)
    .join('|')
}

/**
 * The signature effect-time authorization compares. Terminal output after a
 * candidate was seen can mean a "done" session is still alive, so what the user
 * was shown and what the coordinator re-plans must both carry it.
 */
export function withAgentHibernationOutputSignature<
  T extends { signature: string; paneKeys: readonly string[] }
>(candidate: T): T {
  return {
    ...candidate,
    signature: `${candidate.signature}|output:${getAgentHibernationOutputSignature(candidate.paneKeys)}`
  }
}

export function resetAgentHibernationOutputActivityForTests(): void {
  outputEpochByPaneKey.clear()
}
