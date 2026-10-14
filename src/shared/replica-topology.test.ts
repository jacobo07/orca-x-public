import { describe, expect, it } from 'vitest'
import type { ProjectIdentityCollision } from './project-identity-collisions'
import type { ProjectHostSetup, ProjectHostSetupMethod } from './project-types'
import { deriveReplicaTopology } from './replica-topology'

const ROOT = 'a'.repeat(40)
const ROOT_PROJECT_ID = `git-root:${ROOT}`

type RepoFacts = Parameters<typeof deriveReplicaTopology>[0]['repos'][number]

function setup(
  id: string,
  projectId: string,
  overrides: Partial<ProjectHostSetup> = {}
): ProjectHostSetup {
  return {
    id,
    projectId,
    hostId: 'local',
    repoId: id,
    path: `/srv/${id}`,
    displayName: id,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function gitRepo(id: string, overrides: Partial<RepoFacts> = {}): RepoFacts {
  return { id, kind: 'git', ...overrides }
}

function only(input: Parameters<typeof deriveReplicaTopology>[0]) {
  const [entry] = deriveReplicaTopology(input)
  if (!entry) {
    throw new Error('no entry derived')
  }
  return entry
}

describe('deriveReplicaTopology', () => {
  it.each<[ProjectHostSetupMethod | undefined, string]>([
    ['imported-existing-folder', 'imported'],
    ['cloned', 'cloned'],
    ['provisioned', 'provisioned'],
    ['legacy-repo', 'legacy'],
    [undefined, 'unknown']
  ])('maps setupMethod %s to provenance %s', (method, provenance) => {
    const entry = only({
      setups: [setup('a', 'github:acme/widget', { setupMethod: method as ProjectHostSetupMethod })],
      repos: []
    })

    expect(entry.provenance).toBe(provenance)
  })

  it('groups two setups of one project and marks the relation unverified', () => {
    const entries = deriveReplicaTopology({
      setups: [setup('a', ROOT_PROJECT_ID), setup('b', ROOT_PROJECT_ID, { hostId: 'ssh:gpu-vm' })],
      repos: []
    })

    expect(entries.map((entry) => [entry.setupId, entry.membership, entry.relation])).toEqual([
      ['a', 'grouped', 'unverified'],
      ['b', 'grouped', 'unverified']
    ])
  })

  it.each(['github:acme/widget', 'git:example.test/widget', ROOT_PROJECT_ID])(
    'groups two setups under %s',
    (projectId) => {
      const entries = deriveReplicaTopology({
        setups: [setup('a', projectId), setup('b', projectId)],
        repos: []
      })

      expect(entries.every((entry) => entry.membership === 'grouped')).toBe(true)
    }
  )

  it('lists one setup of a proven project as sole with no relation', () => {
    const entry = only({ setups: [setup('a', ROOT_PROJECT_ID)], repos: [] })

    expect(entry.membership).toBe('sole')
    expect(entry).not.toHaveProperty('relation')
  })

  it('marks a setup named by a same-host-duplicate record colliding, ahead of every other fact', () => {
    const collision: ProjectIdentityCollision = {
      kind: 'same-host-duplicate',
      rootCommit: ROOT,
      hostId: 'local',
      setupIds: ['a', 'b']
    }

    const entries = deriveReplicaTopology({
      setups: [setup('a', 'repo:a'), setup('b', 'repo:b'), setup('c', 'repo:c')],
      repos: [gitRepo('c', { gitRootIdentity: null, gitRootIdentityNoneReason: 'shallow' })],
      identityCollisions: [collision]
    })

    expect(
      entries.map((entry) => [entry.setupId, entry.membership, entry.membershipReason])
    ).toEqual([
      ['a', 'colliding', 'same-host-duplicate'],
      ['b', 'colliding', 'same-host-duplicate'],
      ['c', 'host-local', 'shallow']
    ])
  })

  it('marks a remote-less copy of a remote project colliding with its own reason', () => {
    const entry = only({
      setups: [setup('a', 'repo:a')],
      repos: [],
      identityCollisions: [
        {
          kind: 'shares-root-with-remote-project',
          rootCommit: ROOT,
          hostId: 'local',
          setupIds: ['a'],
          projectIds: ['github:acme/widget']
        }
      ]
    })

    expect(entry).toMatchObject({
      membership: 'colliding',
      membershipReason: 'shares-root-with-remote-project'
    })
  })

  it('reads a git repo whose root was never probed as identity-pending', () => {
    const entry = only({
      setups: [setup('a', 'repo:a')],
      repos: [gitRepo('a', { gitRootIdentity: undefined })]
    })

    expect(entry.membership).toBe('identity-pending')
    expect(entry).not.toHaveProperty('membershipReason')
  })

  it('reads a pending repo on a host that does not report roots as host-not-reporting', () => {
    const entry = only({
      setups: [setup('a', 'repo:a', { hostId: 'runtime:old' })],
      repos: [gitRepo('a')],
      hostReportsRootIdentity: (hostId) => hostId !== 'runtime:old'
    })

    expect(entry).toMatchObject({
      membership: 'identity-pending',
      membershipReason: 'host-not-reporting'
    })
  })

  it('reads a setup with no repo behind it as identity-pending, never sole', () => {
    expect(only({ setups: [setup('a', 'repo:a')], repos: [] }).membership).toBe('identity-pending')
  })

  it.each(['shallow', 'unborn', 'malformed'] as const)(
    'carries the settled-none reason %s on a host-local repo',
    (reason) => {
      const entry = only({
        setups: [setup('a', 'repo:a')],
        repos: [gitRepo('a', { gitRootIdentity: null, gitRootIdentityNoneReason: reason })]
      })

      expect(entry).toMatchObject({ membership: 'host-local', membershipReason: reason })
    }
  )

  it('names a settled none without a recorded reason', () => {
    const entry = only({
      setups: [setup('a', 'repo:a')],
      repos: [gitRepo('a', { gitRootIdentity: null })]
    })

    expect(entry).toMatchObject({ membership: 'host-local', membershipReason: 'no-usable-root' })
  })

  it('lists a folder workspace as host-local with reason folder', () => {
    const entry = only({
      setups: [setup('a', 'repo:a', { kind: 'folder' })],
      repos: [{ id: 'a', kind: 'folder' }]
    })

    expect(entry).toMatchObject({ membership: 'host-local', membershipReason: 'folder' })
  })

  it('keeps a remote-identified repo sole even when its root never settled', () => {
    const entry = only({
      setups: [setup('a', 'github:acme/widget')],
      repos: [gitRepo('a', { gitRootIdentity: null, gitRootIdentityNoneReason: 'unborn' })]
    })

    expect(entry.membership).toBe('sole')
  })

  it('never emits a primary field or a relation on a non-grouped member', () => {
    const entries = deriveReplicaTopology({
      setups: [setup('a', 'repo:a'), setup('b', ROOT_PROJECT_ID)],
      repos: []
    })

    for (const entry of entries) {
      expect(entry).not.toHaveProperty('primary')
      expect(entry).not.toHaveProperty('relation')
    }
  })

  it('carries host and path through unchanged', () => {
    const entry = only({
      setups: [setup('a', ROOT_PROJECT_ID, { hostId: 'ssh:gpu-vm', path: '/data/a' })],
      repos: []
    })

    expect(entry).toMatchObject({
      setupId: 'a',
      projectId: ROOT_PROJECT_ID,
      hostId: 'ssh:gpu-vm',
      path: '/data/a'
    })
  })

  describe('ancestry evidence on a grouped pair (row 60 open leg)', () => {
    const tips = ['b'.repeat(40), 'c'.repeat(40)] as const
    const setups = [
      setup('a', ROOT_PROJECT_ID),
      setup('b', ROOT_PROJECT_ID, { hostId: 'ssh:gex44' })
    ]
    const relationsOf = (relations: Parameters<typeof deriveReplicaTopology>[0]['relations']) =>
      deriveReplicaTopology({ setups, repos: [], relations }).map((e) => [e.membership, e.relation])

    it('names a diverged cross-host pair but keeps it grouped, never merged', () => {
      const diverged = {
        kind: 'diverged' as const,
        mergeBase: ROOT,
        aheadCount: 1,
        behindCount: 2,
        observedTips: tips
      }
      expect(relationsOf(new Map([['b', diverged]]))).toEqual([
        ['grouped', 'unverified'],
        ['grouped', 'diverged']
      ])
    })

    it('keeps unverified when the comparison failed or no evidence exists', () => {
      expect(
        relationsOf(new Map([['b', { kind: 'unknown' as const, reason: 'transfer-interrupted' as const }]]))
      ).toEqual([
        ['grouped', 'unverified'],
        ['grouped', 'unverified']
      ])
      expect(relationsOf(undefined)[1]).toEqual(['grouped', 'unverified'])
    })

    it('reports ahead from verified evidence', () => {
      expect(
        relationsOf(new Map([['b', { kind: 'ahead' as const, count: 2, observedTips: tips }]]))[1]
      ).toEqual(['grouped', 'ahead'])
    })

    it('does not attach a relation to a colliding member', () => {
      const [entry] = deriveReplicaTopology({
        setups,
        repos: [],
        identityCollisions: [
          { kind: 'same-host-duplicate', rootCommit: ROOT, hostId: 'local', setupIds: ['a'] }
        ],
        relations: new Map([['a', { kind: 'ahead' as const, count: 1, observedTips: tips }]])
      })
      expect(entry).not.toHaveProperty('relation')
    })
  })
})
