import {
  getExecutionHostLabel,
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeClientTarget } from '../../runtime/runtime-client-target'

// One measured block per host that holds this project; each is measured against its own replica.
export type PrepareHostBlockSpec = {
  key: string
  repoId: string
  hostLabel: string
  target: RuntimeClientTarget
}

function targetFor(hostId: ExecutionHostId): RuntimeClientTarget {
  const parsed = parseExecutionHostId(hostId)
  // Why: ssh repos are rows on this desktop, so the local IPC measures them over their connection.
  return parsed?.kind === 'runtime'
    ? { kind: 'environment', environmentId: parsed.environmentId }
    : { kind: 'local' }
}

function ownerKey(setup: ProjectHostSetup): string {
  return JSON.stringify([
    setup.hostId,
    setup.executionHostId ?? setup.hostId,
    setup.runtimeOwnerEnvironmentId ?? null
  ])
}

export function selectPrepareHostBlocks(args: {
  repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>
  setups: readonly ProjectHostSetup[]
  selectedSetupId?: string
}): PrepareHostBlockSpec[] {
  const byOwner = new Map<string, ProjectHostSetup>()
  for (const setup of args.setups) {
    if (!setup.repoId.trim()) {
      continue
    }
    const key = ownerKey(setup)
    if (!byOwner.has(key) || setup.id === args.selectedSetupId) {
      byOwner.set(key, setup)
    }
  }
  if (byOwner.size === 0) {
    const hostId = getRepoExecutionHostId(args.repo)
    return [
      {
        key: args.repo.id,
        repoId: args.repo.id,
        hostLabel: getExecutionHostLabel(hostId),
        target: targetFor(hostId)
      }
    ]
  }
  return [...byOwner.values()].map((setup) => {
    const hostId = setup.executionHostId ?? setup.hostId
    return {
      key: setup.id,
      repoId: setup.repoId,
      hostLabel: getExecutionHostLabel(hostId),
      target: targetFor(hostId)
    }
  })
}
