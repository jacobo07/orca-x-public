import type { AppState } from '@/store/types'
import { worktreeUsesRemoteConnection } from '@/store/slices/terminals'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import {
  resolveFocusedCompletedTabAgent,
  resolveFocusedRetainedTabAgent,
  resolveFocusedTabAgent,
  resolveSiblingCompletedTabAgent,
  resolveSiblingRetainedTabAgent,
  resolveSiblingTabAgent
} from './tab-agent'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'

/**
 * Every store fact `useTabAgent` needs about one tab, derived once per store snapshot.
 *
 * Why this exists: the hook used to hold thirteen separate subscriptions, and zustand notifies by
 * iterating its listener Set on every `setState` — so a write about the side panel re-ran all
 * thirteen for every mounted row. Measured at 100 dormant rows, one such write cost 600 calls into
 * the identity resolvers and 400 pane-key strings
 * (`components/terminal-rail/terminal-rail-derivation-fanout.test.tsx`).
 *
 * The strategy is the one `components/tab-bar/terminal-tab-activity-status.ts` already uses for the
 * sibling derivation: key a module cache on the store references read, so a write that touches none
 * of them is a reference-comparison and nothing else.
 *
 * This is a projection, not a store. It is derived, deterministic and non-authoritative; the
 * precedence ladder still lives in `tab-agent.ts` and `use-tab-agent.ts`, unchanged.
 */
export type TabAgentSignals = {
  focusedHookAgent: TuiAgent | null
  siblingHookAgent: TuiAgent | null
  focusedCompletedHookAgent: TuiAgent | null
  siblingCompletedHookAgent: TuiAgent | null
  processAgent: TuiAgent | null
  processShellForeground: boolean
  sleepingSessionAgent: TuiAgent | null
  /** Focused pane's PTY; only used to reset per-process-generation signals on respawn. */
  ptyId: string | null
  completedHookScopeKnown: boolean
  /** Remote worktree OR a remote runtime PTY — the hook only ever uses the disjunction. */
  isRemoteLike: boolean
}

/**
 * What this projection actually derived, so a run in the real app can attribute it.
 *
 * Why counters live in production rather than in a test mock: the happy-dom fan-out test wraps
 * `lib/tab-agent` with `vi.mock` and counts the calls, which a packaged Electron renderer cannot do.
 * Without a counter here, a real-app claim would rest on timings — and this host's clock drifts
 * further than the whole effect. Two integer increments against six resolver calls is not a cost
 * worth gating behind a flag; only the window exposure is (`store/index.ts`).
 */
export type TabAgentProjectionCounters = {
  /** Snapshots in which at least one input reference moved: the projection's generations. */
  generations: number
  /** Full per-tab derivations. Each runs the identity ladder and may mint a pane key. */
  derivations: number
  /** Pane-key strings minted by those derivations. */
  paneKeys: number
  /** Derivations whose every field equalled the prior generation's, so the reference was reused. */
  reusedReferences: number
  /** Asks answered from the current generation's map without deriving anything. */
  cacheHits: number
}

const counters: TabAgentProjectionCounters = {
  generations: 0,
  derivations: 0,
  paneKeys: 0,
  reusedReferences: 0,
  cacheHits: 0
}

export function readTabAgentProjectionCounters(): TabAgentProjectionCounters {
  return { ...counters }
}

export function resetTabAgentProjectionCounters(): void {
  counters.generations = 0
  counters.derivations = 0
  counters.paneKeys = 0
  counters.reusedReferences = 0
  counters.cacheHits = 0
}

/** The store references this projection reads. A write that changes none of them cannot change it. */
type ProjectionInputs = readonly unknown[]

function readInputs(state: AppState): ProjectionInputs {
  return [
    state.agentStatusByPaneKey,
    state.retainedAgentsByPaneKey,
    state.terminalLayoutsByTabId,
    state.ptyIdsByTabId,
    state.paneForegroundAgentByPaneKey,
    state.sleepingAgentSessionsByPaneKey,
    // worktreeUsesRemoteConnection's own inputs; it also flattens worktreesByRepo, so leaving these
    // out would both serve stale answers and keep paying for the flatten.
    state.folderWorkspaces,
    state.projectGroups,
    state.repos,
    state.worktreesByRepo
  ]
}

let cachedInputs: ProjectionInputs | null = null
let cachedEntries = new Map<string, TabAgentSignals>()
let previousEntries = new Map<string, TabAgentSignals>()

function sameInputs(next: ProjectionInputs): boolean {
  if (!cachedInputs || cachedInputs.length !== next.length) {
    return false
  }
  return cachedInputs.every((value, index) => value === next[index])
}

/**
 * Why structural sharing and not just a fresh map: the consumer subscribes to this object, so a new
 * reference is a re-render. Rebuilding on every relevant write would re-render every row whenever
 * any row changed — strictly worse than the thirteen primitive selectors this replaces. Reusing the
 * previous entry when nothing in it moved keeps invalidation exactly as narrow as it was.
 */
function reuseIfUnchanged(tabId: string, fresh: TabAgentSignals): TabAgentSignals {
  const prior = previousEntries.get(tabId)
  if (!prior) {
    return fresh
  }
  const keys = Object.keys(fresh) as (keyof TabAgentSignals)[]
  if (!keys.every((key) => prior[key] === fresh[key])) {
    return fresh
  }
  counters.reusedReferences += 1
  return prior
}

function computeSignals(
  state: AppState,
  tab: Pick<TerminalTab, 'id' | 'worktreeId'>
): TabAgentSignals {
  counters.derivations += 1
  const layout = state.terminalLayoutsByTabId[tab.id]
  const activeLeafId = layout?.activeLeafId
  let focusedPaneKey: string | null = null
  if (activeLeafId && isTerminalLeafId(activeLeafId)) {
    counters.paneKeys += 1
    focusedPaneKey = makePaneKey(tab.id, activeLeafId)
  }
  const foreground = focusedPaneKey ? state.paneForegroundAgentByPaneKey[focusedPaneKey] : undefined

  const leafPty = activeLeafId ? layout?.ptyIdsByLeafId?.[activeLeafId] : undefined
  const tabPtyIds = state.ptyIdsByTabId[tab.id] ?? []
  const ptyId = leafPty ?? (tabPtyIds.length === 1 ? tabPtyIds[0]! : null)

  // Why a loop rather than a Set spread: this runs once per snapshot now, but it ran once per row
  // per write before, and the allocation was a measured part of that cost.
  let hasRemoteRuntimePty = false
  for (const candidate of tabPtyIds) {
    if (parseRemoteRuntimePtyId(candidate) !== null) {
      hasRemoteRuntimePty = true
      break
    }
  }
  if (!hasRemoteRuntimePty && layout?.ptyIdsByLeafId) {
    for (const candidate of Object.values(layout.ptyIdsByLeafId)) {
      if (parseRemoteRuntimePtyId(candidate) !== null) {
        hasRemoteRuntimePty = true
        break
      }
    }
  }

  return {
    focusedHookAgent: resolveFocusedTabAgent(state.agentStatusByPaneKey, layout, tab.id),
    siblingHookAgent: resolveSiblingTabAgent(state.agentStatusByPaneKey, layout, tab.id),
    focusedCompletedHookAgent:
      resolveFocusedCompletedTabAgent(state.agentStatusByPaneKey, layout, tab.id) ??
      resolveFocusedRetainedTabAgent(state.retainedAgentsByPaneKey, layout, tab.id),
    siblingCompletedHookAgent:
      resolveSiblingCompletedTabAgent(state.agentStatusByPaneKey, layout, tab.id) ??
      resolveSiblingRetainedTabAgent(state.retainedAgentsByPaneKey, layout, tab.id),
    processAgent: foreground?.agent ?? null,
    processShellForeground: Boolean(foreground?.shellForeground),
    sleepingSessionAgent: focusedPaneKey
      ? (state.sleepingAgentSessionsByPaneKey[focusedPaneKey]?.agent ?? null)
      : null,
    ptyId,
    // Why: with no layout to place a completed row, only a single-pane tab may treat it as
    // focused-pane exit evidence.
    completedHookScopeKnown:
      Boolean(layout?.activeLeafId && isTerminalLeafId(layout.activeLeafId)) ||
      tabPtyIds.length <= 1,
    isRemoteLike: worktreeUsesRemoteConnection(state, tab.worktreeId) || hasRemoteRuntimePty
  }
}

/**
 * Selector body for `useTabAgent`'s single subscription. Lazy per tab: only rows that actually ask
 * are computed, so a hundred remembered tabs with ten mounted cost ten.
 */
export function selectTabAgentSignals(
  state: AppState,
  tab: Pick<TerminalTab, 'id' | 'worktreeId'>
): TabAgentSignals {
  const inputs = readInputs(state)
  if (!sameInputs(inputs)) {
    counters.generations += 1
    previousEntries = cachedEntries
    cachedEntries = new Map()
    cachedInputs = inputs
  }
  const hit = cachedEntries.get(tab.id)
  if (hit) {
    counters.cacheHits += 1
    return hit
  }
  const entry = reuseIfUnchanged(tab.id, computeSignals(state, tab))
  cachedEntries.set(tab.id, entry)
  return entry
}

/** Test-only: clear the memoized projection between cases. */
export function resetTabAgentProjectionForTest(): void {
  cachedInputs = null
  cachedEntries = new Map()
  previousEntries = new Map()
}
