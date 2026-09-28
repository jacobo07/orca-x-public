import type { AppState } from '@/store/types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { isAgentExitedResumeBlock } from '../../../shared/agent-resume-block-precedence'
import { readPaneSessionResumeCapability } from '@/lib/pane-session-resume-capability'

export type TabSessionResumeTarget =
  | { kind: 'none' }
  /** More than one pane of the tab could resume; the tab cannot choose for the user. */
  | { kind: 'several' }
  | {
      kind: 'one'
      paneKey: string
      /** Why a disabled pane still gets the control: its tooltip says what it is waiting for. */
      state: 'available' | 'disabled'
      reason?: string
    }

/**
 * The pane a tab-level Resume acts on: the tab's own exited sessions only, projected through
 * the pane capability — never the focused pane, never a title or a shell prompt.
 * Encoded as a string so a per-tab store selector re-renders only when the answer changes.
 */
type SleepingRecords = AppState['sleepingAgentSessionsByPaneKey']

const EMPTY_RECORDS: SleepingRecords = {}

// Why keyed on the records map: this runs per tab on every store write, and nearly every write
// leaves that map alone, so a tab with no exited session answers with two lookups.
const exitedPaneKeysByTab = new WeakMap<SleepingRecords, Map<string, string[]>>()

function exitedPaneKeysFor(records: SleepingRecords, tabId: string): readonly string[] {
  let index = exitedPaneKeysByTab.get(records)
  if (!index) {
    index = new Map()
    for (const [paneKey, record] of Object.entries(records)) {
      const owner = parsePaneKey(paneKey)?.tabId
      if (owner && isAgentExitedResumeBlock(record.automaticResumeBlockedBy)) {
        index.set(owner, [...(index.get(owner) ?? []), paneKey])
      }
    }
    exitedPaneKeysByTab.set(records, index)
  }
  return index.get(tabId) ?? []
}

export function resolveTabSessionResumeTargetKey(
  state: AppState,
  tab: { id: string; worktreeId: string }
): string {
  // Why the fallback: partial store fixtures omit the map, and no records means nothing to resume.
  const records = state.sleepingAgentSessionsByPaneKey ?? EMPTY_RECORDS
  let found: string | null = null
  for (const paneKey of exitedPaneKeysFor(records, tab.id)) {
    const capability = readPaneSessionResumeCapability(state, {
      paneKey,
      tabId: tab.id,
      worktreeId: tab.worktreeId
    })
    if (capability.kind !== 'available' && capability.kind !== 'disabled') {
      continue
    }
    if (found !== null) {
      return 'several'
    }
    found =
      capability.kind === 'available'
        ? `one|${paneKey}|available`
        : `one|${paneKey}|disabled|${capability.reason}`
  }
  return found ?? 'none'
}

export function decodeTabSessionResumeTarget(key: string): TabSessionResumeTarget {
  if (key === 'none' || key === 'several') {
    return { kind: key }
  }
  const [, paneKey, state, reason] = key.split('|')
  return state === 'available'
    ? { kind: 'one', paneKey, state: 'available' }
    : { kind: 'one', paneKey, state: 'disabled', reason }
}
