import { describe, expect, it } from 'vitest'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import { PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectHostSetupWithReplicaTopology } from '../../../../shared/replica-topology'
import { PROJECT_RUNTIME_METHODS } from './project-runtime-rpc-methods'

const ROOT = 'a'.repeat(40)
const ROOT_PROJECT_ID = `git-root:${ROOT}`

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/srv/${id}`,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 10,
    kind: 'git',
    gitRemoteIdentity: null,
    gitRootIdentity: { rootCommit: ROOT, commonDir: `/srv/${id}/.git`, shallow: false },
    ...overrides
  }
}

function setup(repoId: string, hostId: string, projectId: string): ProjectHostSetup {
  return {
    id: repoId,
    projectId,
    hostId: hostId as ProjectHostSetup['hostId'],
    repoId,
    path: `/srv/${repoId}`,
    displayName: repoId,
    setupState: 'ready',
    setupMethod: 'cloned',
    createdAt: 10,
    updatedAt: 10
  }
}

const REPOS = [repo('a'), repo('b', { connectionId: 'gpu-vm' })]
const SETUPS = [setup('a', 'local', ROOT_PROJECT_ID), setup('b', 'ssh:gpu-vm', ROOT_PROJECT_ID)]

async function listSetups(clientCapabilities?: string[]) {
  const method = PROJECT_RUNTIME_METHODS.find((entry) => entry.name === 'projectHostSetup.list')
  if (!method) {
    throw new Error('projectHostSetup.list is not registered')
  }
  const context = {
    clientCapabilities,
    runtime: { listRepos: () => REPOS, listProjectHostSetups: () => SETUPS }
  } as never
  return (await method.handler({}, context)) as {
    setups: ProjectHostSetupWithReplicaTopology[]
  }
}

describe('projectHostSetup.list replica topology', () => {
  it('adds replicaTopology from the shared producer for a capable client', async () => {
    const result = await listSetups([PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY])

    expect(result.setups.map((entry) => entry.replicaTopology)).toEqual([
      expect.objectContaining({
        setupId: 'a',
        hostId: 'local',
        provenance: 'cloned',
        membership: 'grouped',
        relation: 'unverified'
      }),
      expect.objectContaining({
        setupId: 'b',
        hostId: 'ssh:gpu-vm',
        membership: 'grouped',
        relation: 'unverified'
      })
    ])
  })

  it('adds it for an in-process caller that declares nothing', async () => {
    const result = await listSetups(undefined)

    expect(result.setups.every((entry) => entry.replicaTopology !== undefined)).toBe(true)
  })

  it('never sends it to a client that does not declare the capability', async () => {
    const result = await listSetups(['session-tabs.close-intent.v1'])

    expect(JSON.stringify(result)).not.toContain('replicaTopology')
    expect(JSON.stringify(result)).not.toContain('identityCollisions')
  })
})
