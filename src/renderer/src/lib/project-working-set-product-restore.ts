import type { RestorePlanBlocker } from '../../../shared/project-working-set-restore-plan'
import type {
  WorkingSetReadResult,
  WorkingSetScopeKey
} from '../../../shared/project-working-set-store-types'
import {
  restoreWorkingSet,
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
