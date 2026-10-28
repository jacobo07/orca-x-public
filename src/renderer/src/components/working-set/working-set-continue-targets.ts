import type { AppState } from '@/store/types'
import { getProjectHostSetupProjectionFromState } from '@/store/project-host-setup-selector'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { WorkingSetScopeKey } from '../../../../shared/project-working-set-store-types'
import type { WorkingSetLocation } from '../../../../shared/project-working-set-types'

/** The slices of the store the offer reads; the dialog passes them through `useShallow`. */
export type ContinueTargetsState = Pick<AppState, 'repos' | 'worktreesByRepo'> &
  Partial<Pick<AppState, 'projects' | 'projectHostSetups'>>

export type ContinueOffer = {
  projectId: string
  sourceSetupId: string
  sourceLocation: Extract<WorkingSetLocation, { kind: 'repo-worktree' }>
  /** Every setup of the project, which the product call needs to judge the translation. */
  setups: ProjectHostSetup[]
  /** Ready setups on another host than the workspace's own. */
  targets: ProjectHostSetup[]
}

type SourceWorkspace = { repoId: string; path: string; projectHostSetupId: string | undefined }

function worktreeIdOf(ownerKey: string): string | null {
  const workspace = parseWorkspaceKey(ownerKey)
  if (workspace === null) {
    return ownerKey
  }
  return workspace.type === 'worktree' ? workspace.worktreeId : null
}

function sourceWorkspaceOf(
  state: ContinueTargetsState,
  worktreeId: string
): SourceWorkspace | null {
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    const found = worktrees.find((worktree) => worktree.id === worktreeId)
    if (found) {
      return {
        repoId: found.repoId,
        path: found.path,
        projectHostSetupId: found.projectHostSetupId
      }
    }
  }
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  return parsed
    ? { repoId: parsed.repoId, path: parsed.worktreePath, projectHostSetupId: undefined }
    : null
}

/** Names the workspace's own setup, or nothing when the store cannot say which one it is. */
function sourceSetupOf(
  source: SourceWorkspace,
  setups: readonly ProjectHostSetup[]
): ProjectHostSetup | null {
  if (source.projectHostSetupId !== undefined) {
    return setups.find((setup) => setup.id === source.projectHostSetupId) ?? null
  }
  const owned = setups.filter((setup) => setup.repoId === source.repoId)
  return owned.length === 1 ? owned[0] : null
}

export function continueOfferFor(
  state: ContinueTargetsState,
  scope: WorkingSetScopeKey
): ContinueOffer | null {
  const worktreeId = worktreeIdOf(scope.ownerKey)
  if (worktreeId === null) {
    return null
  }
  const source = sourceWorkspaceOf(state, worktreeId)
  if (source === null) {
    return null
  }
  const projection = getProjectHostSetupProjectionFromState(state)
  const sourceSetup = sourceSetupOf(source, projection.setups)
  if (sourceSetup === null) {
    return null
  }
  const setups = projection.setups.filter((setup) => setup.projectId === sourceSetup.projectId)
  const targets = setups.filter(
    (setup) =>
      setup.id !== sourceSetup.id &&
      setup.hostId !== sourceSetup.hostId &&
      setup.setupState === 'ready'
  )
  if (targets.length === 0) {
    return null
  }
  return {
    projectId: sourceSetup.projectId,
    sourceSetupId: sourceSetup.id,
    sourceLocation: { kind: 'repo-worktree', repoId: source.repoId, worktreePath: source.path },
    setups,
    targets
  }
}

export function listContinueTargets(
  state: ContinueTargetsState,
  scope: WorkingSetScopeKey
): ProjectHostSetup[] {
  return continueOfferFor(state, scope)?.targets ?? []
}
