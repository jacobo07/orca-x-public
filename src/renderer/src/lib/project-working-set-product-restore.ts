import { useAppStore } from '@/store'
import type {
  ContinuePane,
  HostTranslationRefusal
} from '../../../shared/project-working-set-host-translation'
import type { RestorePlanBlocker } from '../../../shared/project-working-set-restore-plan'
import type {
  WorkingSetReadResult,
  WorkingSetScopeKey
} from '../../../shared/project-working-set-store-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  resolveContinueTarget,
  type ContinueTargetInput
} from './project-working-set-continue-target'
import {
  readContinueSourceState,
  type ContinueSourceState
} from './project-working-set-continue-source-state'
import {
  restoreWorkingSet,
  type ContinueRestoreOutcome,
  type WorkingSetContinueRequest,
  type WorkingSetRestoreOutcome,
  type WorkingSetRestoreRequest
} from './project-working-set-restore'
import { activateAndRevealWorktree } from './worktree-activation'

/**
 * The product's Restore action: one call into the canonical restore, then navigation.
 *
 * Why restore runs before activation: activating an empty workspace seeds a terminal, and a
 * workspace with a tab is one restore refuses. Activation afterwards selects the restored active
 * row, which stays dormant; nothing here opens a row.
 */

export type ProductRestoreRequest = {
  scope: WorkingSetScopeKey
  workingSetId: string
  /** The host's full launch-profile answer, or null when it could not be established. */
  launchProfiles: readonly { id: string }[] | null
}

export type ProductRestoreResult =
  /** Another restore into this workspace has not finished; this click did nothing. */
  | { status: 'in-flight' }
  | { status: 'restored'; rows: number }
  | { status: 'unreadable'; read: Exclude<WorkingSetReadResult, { status: 'valid' }> }
  | { status: 'refused'; blockers: RestorePlanBlocker[] }
  | { status: 'target-changed' }
  | { status: 'failed'; stage: 'hydrate' | 'verify'; rolledBack: boolean }

export type ProductRestoreDeps = {
  restore: (request: WorkingSetRestoreRequest) => Promise<WorkingSetRestoreOutcome>
  activate: (ownerKey: string) => void
}

const defaultDeps: ProductRestoreDeps = {
  restore: (request) => restoreWorkingSet(request),
  activate: (ownerKey) => {
    activateAndRevealWorktree(ownerKey)
  }
}

const inFlightOwnerKeys = new Set<string>()

function project(outcome: WorkingSetRestoreOutcome): ProductRestoreResult {
  if (outcome.status === 'unreadable') {
    return { status: 'unreadable', read: outcome.read }
  }
  const { applied } = outcome
  switch (applied.status) {
    case 'applied':
      return { status: 'restored', rows: applied.targetTabIds.length }
    case 'already-applied':
      return { status: 'restored', rows: outcome.plan.entries.length }
    case 'refused':
      return { status: 'refused', blockers: applied.blockers }
    case 'target-changed':
      return { status: 'target-changed' }
    case 'failed':
      return { status: 'failed', stage: applied.stage, rolledBack: applied.rolledBack }
  }
}

export async function restoreWorkingSetFromProduct(
  request: ProductRestoreRequest,
  deps: ProductRestoreDeps = defaultDeps
): Promise<ProductRestoreResult> {
  const { ownerKey } = request.scope
  // Why per workspace: a second click would replan against the rows the first one just created.
  if (inFlightOwnerKeys.has(ownerKey)) {
    return { status: 'in-flight' }
  }
  inFlightOwnerKeys.add(ownerKey)
  try {
    const result = project(
      await deps.restore({
        scope: request.scope,
        workingSetId: request.workingSetId,
        launchProfiles: request.launchProfiles
      })
    )
    if (result.status === 'restored') {
      deps.activate(ownerKey)
    }
    return result
  } finally {
    inFlightOwnerKeys.delete(ownerKey)
  }
}

export type ProductContinueRequest = ProductRestoreRequest & {
  /** Which setups and which location to continue from and onto; the scope and the store are not repeated. */
  target: Omit<ContinueTargetInput, 'sourceScope' | 'worktrees'>
}

type WithPanes<T> = T & {
  /** What opening each restored row will do on the target host; absent on a plain restore. */
  panes?: ContinuePane[]
}

export type ProductContinueResult =
  | Exclude<ProductRestoreResult, { status: 'restored' | 'refused' }>
  | WithPanes<Extract<ProductRestoreResult, { status: 'restored' | 'refused' }>>
  /** The set cannot be continued there; includes "not set up / not ready there", which is not an error. */
  | { status: 'continue-refused'; reason: HostTranslationRefusal }
  /** The target host's workspace is not one the renderer holds, so there is nowhere to restore to. */
  | {
      status: 'continue-target-unavailable'
      reason: 'target-workspace-missing' | 'source-setup-missing'
    }
  /** Uncommitted work would stay behind, or it could not be checked; nothing was restored. */
  | { status: 'continue-source-not-clean'; reason: Exclude<ContinueSourceState, 'clean'> }

export type ProductContinueDeps = {
  restore: (request: WorkingSetContinueRequest) => Promise<ContinueRestoreOutcome>
  worktrees: () => readonly Worktree[]
  /** Read fresh at the effect; required so no caller can skip it. */
  sourceState: (sourceWorktreeId: string) => Promise<ContinueSourceState>
}

const defaultContinueDeps: ProductContinueDeps = {
  restore: (request) => restoreWorkingSet(request),
  worktrees: () => Object.values(useAppStore.getState().worktreesByRepo).flat(),
  sourceState: (sourceWorktreeId) => readContinueSourceState(sourceWorktreeId)
}

/**
 * Continues a sealed set on another host's setup. It restores dormant rows into the target
 * workspace and returns the per-pane table; it takes no navigation capability, so it cannot open a row.
 */
export async function continueWorkingSetFromProduct(
  request: ProductContinueRequest,
  deps: ProductContinueDeps = defaultContinueDeps
): Promise<ProductContinueResult> {
  const resolution = resolveContinueTarget({
    ...request.target,
    sourceScope: request.scope,
    worktrees: deps.worktrees()
  })
  if (resolution.status === 'refused') {
    return { status: 'continue-refused', reason: resolution.reason }
  }
  if (resolution.status === 'unresolved') {
    return { status: 'continue-target-unavailable', reason: resolution.reason }
  }
  // Why the target: it is the workspace apply mutates, so two sources into one target must contend.
  const targetOwnerKey = resolution.request.targetOwnerKey
  if (inFlightOwnerKeys.has(targetOwnerKey)) {
    return { status: 'in-flight' }
  }
  inFlightOwnerKeys.add(targetOwnerKey)
  try {
    const sourceState = await deps.sourceState(request.scope.ownerKey)
    if (sourceState !== 'clean') {
      return { status: 'continue-source-not-clean', reason: sourceState }
    }
    const outcome = await deps.restore({
      scope: request.scope,
      workingSetId: request.workingSetId,
      launchProfiles: request.launchProfiles,
      continueOn: resolution.request
    })
    if (outcome.status === 'continue-refused') {
      return { status: 'continue-refused', reason: outcome.reason }
    }
    const result = project(outcome)
    return outcome.status === 'planned' &&
      (result.status === 'restored' || result.status === 'refused')
      ? { ...result, panes: outcome.panes }
      : result
  } finally {
    inFlightOwnerKeys.delete(targetOwnerKey)
  }
}
