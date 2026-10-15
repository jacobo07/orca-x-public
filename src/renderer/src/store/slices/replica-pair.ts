import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { publishedRelationsOf, type ReplicaPairView } from '../../../../shared/replica-pair-view'
import type { ReplicaRelation } from '../../../../shared/workspace-replica-state'
import { getActiveRuntimeTarget } from '@/runtime/runtime-client-target'
import { compareReplicaPairs, readReplicaRelations } from '@/runtime/runtime-replica-pair-client'

export type ReplicaPairUnavailableReason = 'remote-caller' | 'no-replica-service'
export type ReplicaPairFailedReason = 'unknown-project' | 'unknown-setup' | 'transport'

export type ReplicaPairState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'ready'
      views: ReplicaPairView[]
      /** Built once per answer by publishedRelationsOf; the selector reads this map, never view.relation. */
      relations: ReadonlyMap<string, ReplicaRelation>
    }
  | { status: 'unavailable'; reason: ReplicaPairUnavailableReason }
  | { status: 'failed'; reason: ReplicaPairFailedReason; message?: string }

export type ReplicaPairSlice = {
  replicaPair: ReplicaPairState
  refreshReplicaPairRelations: () => Promise<void>
  compareReplicaPairsForProject: (projectId: string, setupId?: string) => Promise<void>
}

type PairAnswer =
  | { status: 'ok'; pairs: ReplicaPairView[] }
  | { status: 'refused'; reason: 'remote-caller' }
  | { status: 'unavailable'; reason: 'no-replica-service' }
  | { status: 'not-found'; reason: 'unknown-project' | 'unknown-setup' }

function readyState(views: ReplicaPairView[]): ReplicaPairState {
  return { status: 'ready', views, relations: publishedRelationsOf(views) }
}

function mergeViews(
  current: ReplicaPairState,
  incoming: readonly ReplicaPairView[]
): ReplicaPairView[] {
  const base = current.status === 'ready' ? current.views : []
  const answered = new Map(incoming.map((view) => [view.setupId, view]))
  const merged = base.map((view) => answered.get(view.setupId) ?? view)
  const known = new Set(base.map((view) => view.setupId))
  return [...merged, ...incoming.filter((view) => !known.has(view.setupId))]
}

function stateFromAnswer(answer: PairAnswer, current: ReplicaPairState, merge: boolean) {
  switch (answer.status) {
    case 'ok':
      return readyState(merge ? mergeViews(current, answer.pairs) : answer.pairs)
    case 'refused':
    case 'unavailable':
      return { status: 'unavailable', reason: answer.reason } satisfies ReplicaPairState
    case 'not-found':
      return { status: 'failed', reason: answer.reason } satisfies ReplicaPairState
  }
}

export const createReplicaPairSlice: StateCreator<AppState, [], [], ReplicaPairSlice> = (
  set,
  get
) => {
  // Why: one counter per store; a slow answer for an older request must not overwrite a newer one.
  let generation = 0

  async function settle(
    request: () => Promise<PairAnswer>,
    merge: boolean,
    showLoading: boolean
  ): Promise<void> {
    const mine = ++generation
    if (showLoading) {
      set({ replicaPair: { status: 'loading' } })
    }
    let next: ReplicaPairState
    try {
      const answer = await request()
      if (mine !== generation) {
        return
      }
      next = stateFromAnswer(answer, get().replicaPair, merge)
    } catch (error) {
      if (mine !== generation) {
        return
      }
      // Why: a throw is a failure, never an empty or healthy pair list.
      next = {
        status: 'failed',
        reason: 'transport',
        message: error instanceof Error ? error.message : String(error)
      }
    }
    set({ replicaPair: next })
  }

  return {
    replicaPair: { status: 'idle' },

    refreshReplicaPairRelations: () =>
      settle(() => readReplicaRelations(getActiveRuntimeTarget(get().settings)), false, true),

    compareReplicaPairsForProject: (projectId, setupId) =>
      settle(
        () => compareReplicaPairs(getActiveRuntimeTarget(get().settings), projectId, setupId),
        true,
        false
      )
  }
}
