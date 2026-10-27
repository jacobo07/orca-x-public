import type { WorkspaceRowModel } from './resume-center-model'
import {
  defaultWakeDeps,
  resumeDeskOrphan,
  resumeDeskTab,
  type WakeDeps
} from './resume-center-wake'
import { setResumeAllState, type WakePhase } from './resume-center-wake-state'

export type ResumeAllItem =
  | { kind: 'tab'; row: WorkspaceRowModel; tabId: string }
  | { kind: 'orphan'; row: WorkspaceRowModel; paneKey: string }

/** Everything asleep on the desk, in desk order: each workspace's rows, then its tab-less agents. */
export function planResumeAll(rows: readonly WorkspaceRowModel[]): ResumeAllItem[] {
  return rows.flatMap((row) => [
    ...row.tabs
      .filter((tab) => tab.residency !== 'warm')
      .map((tab): ResumeAllItem => ({ kind: 'tab', row, tabId: tab.tabId })),
    ...row.orphanSessions.map(
      (orphan): ResumeAllItem => ({ kind: 'orphan', row, paneKey: orphan.paneKey })
    )
  ])
}

export type ResumeAllOutcome =
  | { status: 'finished'; started: number; leftAsleep: number }
  | { status: 'stopped'; started: number; resumeFrom: number; reason: string; detail: string }

let inFlight: Promise<ResumeAllOutcome> | null = null
// Why module scope: the first wake switches the view, so the page that started this unmounts.
let paused: { items: readonly ResumeAllItem[]; resumeFrom: number } | null = null

/**
 * One wake at a time, each asked of the admission owner and waited on until its PTY binds or its
 * bound passes. A host that cannot be measured skips that item; any other refusal stops the queue and
 * leaves the rest asleep until Continue asks again. A second call while one runs joins it.
 */
export function runResumeAll(
  items: readonly ResumeAllItem[],
  startAt = 0,
  deps: WakeDeps = defaultWakeDeps
): Promise<ResumeAllOutcome> {
  inFlight ??= drive(items, startAt, deps).finally(() => {
    inFlight = null
  })
  return inFlight
}

/** Continue: ask again from where a stopped Resume all left off, over the same plan. */
export function continueResumeAll(
  deps: WakeDeps = defaultWakeDeps
): Promise<ResumeAllOutcome> | null {
  const current = paused
  return current ? runResumeAll(current.items, current.resumeFrom, deps) : null
}

export function hasPausedResumeAll(): boolean {
  return paused !== null
}

async function drive(
  items: readonly ResumeAllItem[],
  startAt: number,
  deps: WakeDeps
): Promise<ResumeAllOutcome> {
  let started = 0
  let leftAsleep = 0
  paused = null
  for (let index = startAt; index < items.length; index++) {
    setResumeAllState({ status: 'running', done: index - startAt, total: items.length - startAt })
    const item = items[index]!
    const phase: WakePhase =
      item.kind === 'tab'
        ? await resumeDeskTab(item.row, item.tabId, 'resume-all', deps)
        : await resumeDeskOrphan(item.row, item.paneKey, 'resume-all', deps)
    if (phase.phase === 'running') {
      started += 1
      continue
    }
    const hostWide =
      phase.phase === 'unavailable'
        ? { reason: 'unavailable', detail: 'this client cannot start sessions' }
        : phase.phase === 'refused' && phase.reason !== 'executor-unobservable'
          ? { reason: phase.reason, detail: phase.detail }
          : null
    if (hostWide) {
      const outcome = {
        status: 'stopped' as const,
        started,
        resumeFrom: index,
        reason: hostWide.reason,
        detail: hostWide.detail
      }
      // Before publishing, so the page that renders "paused" can already offer Continue.
      paused = { items, resumeFrom: index }
      setResumeAllState({
        status: 'stopped',
        started,
        remaining: items.length - index,
        reason: hostWide.reason,
        detail: hostWide.detail
      })
      return outcome
    }
    leftAsleep += 1
  }
  setResumeAllState({ status: 'finished', started, leftAsleep })
  return { status: 'finished', started, leftAsleep }
}
