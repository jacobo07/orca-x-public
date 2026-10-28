import type { ExecutionHostId } from './execution-host'

/** Repos of one host that share a first commit but are different repositories. */
export type SameHostDuplicateGroup = {
  rootCommit: string
  hostId: ExecutionHostId
  setupIds: string[]
}

/** Remote-less repos whose first commit is also the first commit of a remote project. */
export type SharesRootWithRemoteGroup = SameHostDuplicateGroup & {
  projectIds: string[]
}

export type ProjectIdentityCollision =
  | ({ kind: 'same-host-duplicate' } & SameHostDuplicateGroup)
  | ({ kind: 'shares-root-with-remote-project' } & SharesRootWithRemoteGroup)

type CollisionGroups = {
  sameHostDuplicates: readonly SameHostDuplicateGroup[]
  sharesRootWithRemote: readonly SharesRootWithRemoteGroup[]
}

function compareCollisions(a: ProjectIdentityCollision, b: ProjectIdentityCollision): number {
  return (
    a.kind.localeCompare(b.kind) ||
    a.rootCommit.localeCompare(b.rootCommit) ||
    a.hostId.localeCompare(b.hostId)
  )
}

/** Recomputed on every projection; a collision is a fact about the repo set, never a stored decision. */
export function projectIdentityCollisionsFromEligibility(
  groups: CollisionGroups
): ProjectIdentityCollision[] {
  const records: ProjectIdentityCollision[] = [
    ...groups.sameHostDuplicates.map((group) => ({
      kind: 'same-host-duplicate' as const,
      rootCommit: group.rootCommit,
      hostId: group.hostId,
      setupIds: [...group.setupIds].sort()
    })),
    ...groups.sharesRootWithRemote.map((group) => ({
      kind: 'shares-root-with-remote-project' as const,
      rootCommit: group.rootCommit,
      hostId: group.hostId,
      setupIds: [...group.setupIds].sort(),
      projectIds: [...group.projectIds].sort()
    }))
  ]
  return records.sort(compareCollisions)
}
