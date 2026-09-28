import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/resume-sleeping-agent-session'
import type { WakeAdmissionResult } from '../../../../shared/desk-continuity-read-types'
import type { WorkspaceRowModel } from './resume-center-model'
import { restoreWorkspaceLayoutOnly, type LayoutRestoreResult } from './resume-center-restore'
import { setWakePhase, type WakePhase } from './resume-center-wake-state'

/** How long an asked-for open may take to bind a PTY before the row says it has not started. */
export const WAKE_BIND_TIMEOUT_MS = 60_000

export type WakeDeps = {
  admit: (row: WorkspaceRowModel) => Promise<WakeAdmissionResult>
  restore: (row: WorkspaceRowModel) => Promise<LayoutRestoreResult>
  /** Resolves true once `ready()` holds, false when the bound passes first. */
  waitFor: (ready: () => boolean, timeoutMs: number) => Promise<boolean>
}

function waitForStore(ready: () => boolean, timeoutMs: number): Promise<boolean> {
  if (ready()) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const unsubscribe = useAppStore.subscribe(() => {
      if (ready()) {
        clearTimeout(timer)
        unsubscribe()
        resolve(true)
      }
    })
    const timer = setTimeout(() => {
      unsubscribe()
      resolve(false)
    }, timeoutMs)
  })
}

export const defaultWakeDeps: WakeDeps = {
  admit: (row) => window.api.continuity.admitWake({ hostId: row.hostId, workspaceKey: row.key }),
  restore: restoreWorkspaceLayoutOnly,
  waitFor: waitForStore
}

export type WakeMode = 'selected' | 'resume-all'

/**
 * Admission, read for the kind of intent it guards. A host this process cannot measure refuses a
 * Resume all outright, but a Resume the user picked goes ahead, said to be unmeasured: its own
 * owner still checks it. Returns the phase to stop at, or null to go on.
 */
function gate(
  admission: WakeAdmissionResult,
  mode: WakeMode
): { stop: WakePhase } | { go: { notMeasured: boolean } } {
  if (admission.verdict === 'admitted') {
    return { go: { notMeasured: false } }
  }
  if (admission.verdict === 'unavailable') {
    return { stop: { phase: 'unavailable' } }
  }
  if (admission.reason === 'executor-unobservable' && mode === 'selected') {
    return { go: { notMeasured: true } }
  }
  return { stop: { phase: 'refused', reason: admission.reason, detail: admission.detail } }
}

function findTab(worktreeKey: string, tabId: string) {
  return useAppStore.getState().tabsByWorktree[worktreeKey]?.find((tab) => tab.id === tabId)
}

/** Resume one remembered row. The row is `running` only once a PTY binds and clears its marker. */
export async function resumeDeskTab(
  row: WorkspaceRowModel,
  tabId: string,
  mode: WakeMode = 'selected',
  deps: WakeDeps = defaultWakeDeps
): Promise<WakePhase> {
  const settle = (phase: WakePhase): WakePhase => {
    setWakePhase(tabId, phase)
    return phase
  }
  settle({ phase: 'admission-pending' })
  const decision = gate(await deps.admit(row), mode)
  if ('stop' in decision) {
    return settle(decision.stop)
  }
  const restored = await deps.restore(row)
  const outcome = restored.outcomes.find((entry) => entry.tabId === tabId)?.outcome
  if (outcome === 'running') {
    // Already live on its host: showing it again is a reattach, not a wake.
    return settle({ phase: 'running' })
  }
  if (!findTab(row.key, tabId)) {
    return settle({ phase: 'failed', reason: 'not-found' })
  }
  const state = useAppStore.getState()
  state.requestDormantTerminalTabOpen(tabId)
  state.setActiveTab(tabId)
  settle({ phase: 'materializing', notMeasured: decision.go.notMeasured })
  const bound = await deps.waitFor(() => {
    const tab = findTab(row.key, tabId)
    return tab !== undefined && tab.dormancy === undefined
  }, WAKE_BIND_TIMEOUT_MS)
  return settle(bound ? { phase: 'running' } : { phase: 'failed', reason: 'not-started' })
}

/** Resume an agent whose tab is gone, through the canonical sleeping-agent resume, for that record only. */
export async function resumeDeskOrphan(
  row: WorkspaceRowModel,
  paneKey: string,
  mode: WakeMode = 'selected',
  deps: WakeDeps = defaultWakeDeps
): Promise<WakePhase> {
  const settle = (phase: WakePhase): WakePhase => {
    setWakePhase(paneKey, phase)
    return phase
  }
  settle({ phase: 'admission-pending' })
  const decision = gate(await deps.admit(row), mode)
  if ('stop' in decision) {
    return settle(decision.stop)
  }
  await deps.restore(row)
  let launchedTabId: string | null = null
  const launched = resumeSleepingAgentSessionsForWorktree(row.key, {
    onlyPaneKeys: new Set([paneKey]),
    onSessionLaunched: (tabId) => {
      launchedTabId = tabId
    }
  })
  if (launched === 0 || launchedTabId === null) {
    // The canonical resume declined it (superseded, claimed elsewhere, or no longer resumable).
    return settle({ phase: 'failed', reason: 'not-launched' })
  }
  const newTabId: string = launchedTabId
  settle({ phase: 'materializing', notMeasured: decision.go.notMeasured })
  const bound = await deps.waitFor(
    () => (useAppStore.getState().ptyIdsByTabId[newTabId] ?? []).length > 0,
    WAKE_BIND_TIMEOUT_MS
  )
  return settle(bound ? { phase: 'running' } : { phase: 'failed', reason: 'not-started' })
}
