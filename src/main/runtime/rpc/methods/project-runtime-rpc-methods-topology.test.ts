import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import { PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { Repo } from '../../../../shared/repo-types'
import type { ReplicaPairView } from '../../../../shared/replica-pair-view'
import type { ProjectHostSetupWithReplicaTopology } from '../../../../shared/replica-topology'
import type { ReplicaPairService } from '../../../replica-pair-service'
import { installReplicaPairService } from '../../../replica-pair-service-slot'
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

async function listSetups(clientCapabilities?: string[], callerStamp: object = {}) {
  const method = PROJECT_RUNTIME_METHODS.find((entry) => entry.name === 'projectHostSetup.list')
  if (!method) {
    throw new Error('projectHostSetup.list is not registered')
  }
  const context = {
    ...callerStamp,
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

const TIP = 'b'.repeat(40)

function pairView(healthy: boolean): ReplicaPairView {
  return {
    setupId: 'b',
    anchorSetupId: 'a',
    hostId: 'ssh:gpu-vm',
    relation: { kind: 'same', observedTips: [TIP, TIP] },
    healthy
  }
}

function fakeService(views: ReplicaPairView[]) {
  const relations = vi.fn(async () => ({ status: 'ok' as const, pairs: views }))
  const service: ReplicaPairService = { compare: vi.fn(), relations }
  return { service, relations }
}

const TOPOLOGY_OF_B_UNVERIFIED_DIRTY = {
  setupId: 'b',
  projectId: ROOT_PROJECT_ID,
  hostId: 'ssh:gpu-vm',
  path: '/srv/b',
  provenance: 'cloned',
  membership: 'grouped',
  relation: 'unverified',
  relationUnknownReason: 'worktree-not-verified-clean'
}

describe('projectHostSetup.list fed by the replica pair service (row 62)', () => {
  afterEach(() => installReplicaPairService(null))

  it('publishes equal-but-dirty as unverified with the closed reason, asking the service once', async () => {
    const { service, relations } = fakeService([pairView(false)])
    installReplicaPairService(service)

    const result = await listSetups([PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY])

    expect(result.setups[1]?.replicaTopology).toEqual(TOPOLOGY_OF_B_UNVERIFIED_DIRTY)
    expect(relations).toHaveBeenCalledTimes(1)
  })

  it('publishes equal and verified clean as same with no reason (control)', async () => {
    installReplicaPairService(fakeService([pairView(true)]).service)

    const topology = (await listSetups([PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY])).setups[1]
      ?.replicaTopology

    expect(topology).toMatchObject({ relation: 'same' })
    expect(topology).not.toHaveProperty('relationUnknownReason')
  })

  it('gives an in-process caller the same feed as a capable client', async () => {
    const { service, relations } = fakeService([pairView(false)])
    installReplicaPairService(service)

    const result = await listSetups(undefined)

    expect(result.setups[1]?.replicaTopology).toEqual(TOPOLOGY_OF_B_UNVERIFIED_DIRTY)
    expect(relations).toHaveBeenCalledTimes(1)
  })

  it('leaves a legacy client byte-identical to an empty slot and never asks the service', async () => {
    const legacyWithoutService = await listSetups(['session-tabs.close-intent.v1'])
    const { service, relations } = fakeService([pairView(false)])
    installReplicaPairService(service)

    const legacy = await listSetups(['session-tabs.close-intent.v1'])

    expect(legacy).toEqual(legacyWithoutService)
    expect(JSON.stringify(legacy)).not.toContain('replicaTopology')
    expect(relations).not.toHaveBeenCalled()
  })

  it('publishes grouped members as plain unverified when the slot is empty (headless serve)', async () => {
    installReplicaPairService(null)

    const result = await listSetups([PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY])

    for (const entry of result.setups) {
      expect(entry.replicaTopology).toMatchObject({ membership: 'grouped', relation: 'unverified' })
      expect(entry.replicaTopology).not.toHaveProperty('relationUnknownReason')
    }
  })

  it('serves a remote caller the same entries as a local one, with the service asked once each', async () => {
    const { service, relations } = fakeService([pairView(false)])
    installReplicaPairService(service)
    const capable = [PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY]

    const local = await listSetups(capable)
    const remote = await listSetups(capable, { pairedDeviceId: 'dev-1', clientKind: 'mobile' })

    expect(remote).toEqual(local)
    expect(remote.setups[1]?.replicaTopology).toEqual(TOPOLOGY_OF_B_UNVERIFIED_DIRTY)
    expect(relations).toHaveBeenCalledTimes(2)
  })

  it('degrades to unreasoned unverified when the service cannot answer, never to a failed list', async () => {
    const relations = vi.fn(async () => {
      throw new Error('git read failed')
    })
    installReplicaPairService({ compare: vi.fn(), relations } as unknown as ReplicaPairService)

    const result = await listSetups([PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY])

    expect(result.setups[1]?.replicaTopology).toMatchObject({
      relation: 'unverified'
    })
    expect(result.setups[1]?.replicaTopology).not.toHaveProperty('relationUnknownReason')
  })
})
