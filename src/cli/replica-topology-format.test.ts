import { describe, expect, it } from 'vitest'
import type { Project } from '../shared/project-types'
import type { ProjectHostSetupWithReplicaTopology } from '../shared/replica-topology'
import { formatProjectHostSetupList, formatProjectList } from './project-format'
import {
  identityBasisOfProjectId,
  NOT_REPORTED_BY_HOST,
  REPLICA_LIST_HEADER
} from './replica-topology-format'

const ROOT_PROJECT_ID = `git-root:${'a'.repeat(40)}`

function setup(
  id: string,
  overrides: Partial<ProjectHostSetupWithReplicaTopology> = {}
): ProjectHostSetupWithReplicaTopology {
  return {
    id,
    projectId: ROOT_PROJECT_ID,
    hostId: 'local',
    repoId: id,
    path: `/srv/${id}`,
    displayName: id,
    setupState: 'ready',
    setupMethod: 'cloned',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function grouped(id: string, hostId: 'local' | 'ssh:gpu-vm') {
  return setup(id, {
    hostId,
    replicaTopology: {
      setupId: id,
      projectId: ROOT_PROJECT_ID,
      hostId,
      path: `/srv/${id}`,
      provenance: 'cloned',
      membership: 'grouped',
      relation: 'unverified'
    }
  })
}

describe('formatProjectHostSetupList', () => {
  it('prints a header, one row per replica with role, membership and relation, and the scope footer', () => {
    const lines = formatProjectHostSetupList(
      { setups: [grouped('a', 'local'), grouped('b', 'ssh:gpu-vm')] },
      'the connected Orca runtime (rt-1)'
    ).split('\n')

    expect(lines[0]).toBe(REPLICA_LIST_HEADER)
    expect(lines[1]).toBe(
      `a  project:${ROOT_PROJECT_ID}  host:local  ready  cloned  grouped  unverified  /srv/a`
    )
    expect(lines[2]).toContain('host:ssh:gpu-vm  ready  cloned  grouped  unverified  /srv/b')
    expect(lines[3]).toBe(
      'Replicas known to the connected Orca runtime (rt-1); replicas owned by other paired Orca servers are not listed here.'
    )
    expect(lines).toHaveLength(4)
  })

  it('prints a dash for the relation of a replica that is not grouped and the reason in parentheses', () => {
    const text = formatProjectHostSetupList({
      setups: [
        setup('a', {
          projectId: 'repo:a',
          replicaTopology: {
            setupId: 'a',
            projectId: 'repo:a',
            hostId: 'local',
            path: '/srv/a',
            provenance: 'imported',
            membership: 'host-local',
            membershipReason: 'shallow'
          }
        })
      ]
    })

    expect(text).toContain('imported  host-local (shallow)  -  /srv/a')
  })

  it('prints the explicit unknown for a host whose Orca version reports no topology', () => {
    const row = formatProjectHostSetupList({ setups: [setup('a')] }).split('\n')[1]

    expect(row).toBe(
      `a  project:${ROOT_PROJECT_ID}  host:local  ready  ${NOT_REPORTED_BY_HOST}  ${NOT_REPORTED_BY_HOST}  ${NOT_REPORTED_BY_HOST}  /srv/a`
    )
    expect(NOT_REPORTED_BY_HOST).toBe("not reported by this host's Orca version")
  })

  it('names the runtime scope on every output, including an empty one', () => {
    const empty = formatProjectHostSetupList({ setups: [] })

    expect(empty).toContain('No project host setups found.')
    expect(empty).toContain('replicas owned by other paired Orca servers are not listed here.')
    expect(empty).toContain('the connected Orca runtime')
  })
})

describe('project list identity basis', () => {
  it.each([
    ['github:acme/widget', 'github'],
    ['git:example.test/acme/widget', 'git'],
    [ROOT_PROJECT_ID, 'git-root'],
    ['repo:abc', 'host-local'],
    ['mystery', 'unknown']
  ])('derives the basis of %s as %s', (id, basis) => {
    expect(identityBasisOfProjectId(id)).toBe(basis)
  })

  it('prints the basis on each project row', () => {
    const project = (id: string): Project => ({
      id,
      displayName: id,
      badgeColor: '#737373',
      sourceRepoIds: [],
      createdAt: 1,
      updatedAt: 1
    })

    const lines = formatProjectList({
      projects: [project(ROOT_PROJECT_ID), project('repo:x')]
    }).split('\n')

    expect(lines[0]).toMatch(/basis:git-root$/)
    expect(lines[1]).toMatch(/basis:host-local$/)
  })
})
