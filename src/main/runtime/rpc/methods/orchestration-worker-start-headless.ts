import { isHeadlessHandle } from '../../orchestration/headless-coordinator'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { WorkerStartInput } from './orchestration-worker-start-schema'

export const HEADLESS_COORDINATOR_HAS_NO_WORKTREE = 'headless_coordinator_has_no_worktree'

/**
 * Placement rules for a worker started by a headless coordinator (spec K4 change 8). It has no
 * terminal and so no worktree of its own: the worker must go to a new top-level worktree of an
 * exact repo, or to an exact existing worktree. Runs before any Dispatch row or effect exists.
 */
export function assertHeadlessWorkerStartPlacement(params: WorkerStartInput): void {
  if (!isHeadlessHandle(params.from)) {
    return
  }
  const worktree = params.worktree ?? 'current'
  if (worktree === 'current' || worktree === 'new-child') {
    throw new OrchestrationError(
      HEADLESS_COORDINATOR_HAS_NO_WORKTREE,
      `A headless coordinator has no worktree, so --worktree ${worktree} has nothing to refer to. Use --worktree new-top-level --repo <exact> --name <name>, or an exact --worktree selector. No effects were applied.`
    )
  }
  // Why: a reused terminal was not started by this Dispatch, so it carries no trusted dispatch id
  // (K2) and the worker could not prove which Dispatch it belongs to.
  if (params.terminal) {
    throw new OrchestrationError(
      'invalid_argument',
      'A headless coordinator cannot reuse an existing terminal; omit --terminal so Orca starts the worker. No effects were applied.'
    )
  }
  if (worktree === 'new-top-level' && (!params.repo || !params.name)) {
    throw new OrchestrationError(
      'invalid_argument',
      'A headless coordinator creating a worktree must name it with --name and choose the repo with an exact --repo. No effects were applied.'
    )
  }
}
