import {
  translateWorkingSetToHost,
  type HostTranslationRefusal,
  type HostTranslationRequest
} from '../../../shared/project-working-set-host-translation'
import type { ProjectHostSetup } from '../../../shared/project-types'
import type { WorkingSetScopeKey } from '../../../shared/project-working-set-store-types'
import {
  PROJECT_WORKING_SET_MANIFEST_VERSION,
  type ProjectWorkingSetManifest,
  type WorkingSetLocation
} from '../../../shared/project-working-set-types'
import type { Worktree } from '../../../shared/worktree/types'

/**
 * Where "Continue here" lands: the target host's workspace for a project setup, found among the
 * worktrees the renderer already holds. Lookup only, so a key that is not a store worktree id is
 * never produced.
 */

export type ContinueTargetInput = {
  projectId: string
  sourceScope: WorkingSetScopeKey
  /** Where the working set lived at capture (the manifest's scope location). */
  sourceLocation: WorkingSetLocation
  sourceSetupId: string
  targetSetupId: string
  /** Every setup of the project, as the setups projection reports them. */
  setups: readonly ProjectHostSetup[]
  /** Every worktree the renderer store holds. */
  worktrees: readonly Worktree[]
}

export type ContinueTargetResolution =
  | { status: 'resolved'; request: HostTranslationRequest }
  /** The translation itself says no, whatever workspace exists. */
  | { status: 'refused'; reason: HostTranslationRefusal }
  | { status: 'unresolved'; reason: 'source-setup-missing' | 'target-workspace-missing' }

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

// A translation refusal never reads the owner key, so a probe can ask it before any workspace exists.
function probeManifest(input: ContinueTargetInput): ProjectWorkingSetManifest {
  return {
    manifestVersion: PROJECT_WORKING_SET_MANIFEST_VERSION,
    workingSetId: '',
    label: null,
    createdAt: 0,
    scope: { ...input.sourceScope, location: input.sourceLocation },
    railGroups: [],
    revivalOrder: [],
    activeTabId: null,
    entries: []
  }
}

export function resolveContinueTarget(input: ContinueTargetInput): ContinueTargetResolution {
  const sourceSetup = input.setups.find((setup) => setup.id === input.sourceSetupId)
  if (!sourceSetup) {
    return { status: 'unresolved', reason: 'source-setup-missing' }
  }
  const targetSetup = input.setups.find((setup) => setup.id === input.targetSetupId) ?? null
  const probe = translateWorkingSetToHost(probeManifest(input), {
    projectId: input.projectId,
    sourceSetup,
    targetSetup,
    targetOwnerKey: ''
  })
  if (probe.kind === 'refused') {
    return { status: 'refused', reason: probe.reason }
  }
  const { location } = probe.manifest.scope
  if (!targetSetup || location.kind !== 'repo-worktree') {
    return { status: 'refused', reason: 'location-kind-unsupported' }
  }
  const wanted = trimTrailingSeparators(location.worktreePath)
  const matches = input.worktrees.filter(
    (worktree) =>
      worktree.repoId === location.repoId &&
      trimTrailingSeparators(worktree.path) === wanted &&
      (worktree.projectHostSetupId === undefined || worktree.projectHostSetupId === targetSetup.id)
  )
  // Why not pick one of several: two store entries for one location is not a fact to choose from.
  if (matches.length !== 1) {
    return { status: 'unresolved', reason: 'target-workspace-missing' }
  }
  return {
    status: 'resolved',
    request: {
      projectId: input.projectId,
      sourceSetup,
      targetSetup,
      targetOwnerKey: matches[0].id
    }
  }
}
