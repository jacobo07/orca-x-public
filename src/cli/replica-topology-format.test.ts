import { describe, expect, it, vi } from 'vitest'
import type { Project } from '../shared/project-types'
import type { ProjectHostSetupWithReplicaTopology } from '../shared/replica-topology'
import { PROJECT_HANDLERS } from './handlers/project'
import { formatProjectHostSetupList, formatProjectList } from './project-format'
import type { FanOutListing } from './handlers/project-setups-all-environments'
import {
  formatFanOutListing,
  identityBasisOfProjectId,
  NOT_REPORTED_BY_HOST,
  REPLICA_LIST_HEADER,
  replicaListFooter
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

describe('relation column text (row 62)', () => {
  type Extra = Partial<NonNullable<ProjectHostSetupWithReplicaTopology['replicaTopology']>>
  const relationOf = (extra: Extra): string => {
    const row = formatProjectHostSetupList({
      setups: [
        setup('b', {
          hostId: 'ssh:gpu-vm',
          replicaTopology: {
            setupId: 'b',
            projectId: ROOT_PROJECT_ID,
            hostId: 'ssh:gpu-vm',
            path: '/srv/b',
            provenance: 'cloned',
            membership: 'grouped',
            ...extra
          }
        })
      ]
    }).split('\n')[1]
    return (row ?? '').split('  ')[6] ?? ''
  }

  it.each<[Extra, string]>([
    [{ relation: 'same' }, 'same'],
    [{ relation: 'ahead', relationAhead: 2 }, 'ahead 2'],
    [{ relation: 'behind', relationBehind: 1 }, 'behind 1'],
    [{ relation: 'diverged', relationAhead: 3, relationBehind: 4 }, 'diverged +3/-4'],
    [{ relation: 'unrelated' }, 'unrelated'],
    [{ relation: 'ahead' }, 'ahead'],
    [{ relation: 'diverged' }, 'diverged']
  ])('prints %j as %s', (extra, text) => {
    expect(relationOf(extra)).toBe(text)
  })

  it('prints the closed reason of an unverified entry in parentheses', () => {
    expect(
      relationOf({ relation: 'unverified', relationUnknownReason: 'worktree-not-verified-clean' })
    ).toBe('unverified (worktree-not-verified-clean)')
  })

  it('prints a bare unverified when no reason was published, and a dash when there is no relation (control)', () => {
    expect(relationOf({ relation: 'unverified' })).toBe('unverified')
    expect(relationOf({})).toBe('-')
  })

  it('never appends a reason to a known relation (control)', () => {
    expect(relationOf({ relation: 'same', relationUnknownReason: 'relay-too-old' })).toBe('same')
  })
})

describe('orca project setups --json (row 62)', () => {
  it('passes the new entry fields through untouched', async () => {
    const entry = {
      setupId: 'b',
      projectId: ROOT_PROJECT_ID,
      hostId: 'ssh:gpu-vm' as const,
      path: '/srv/b',
      provenance: 'cloned' as const,
      membership: 'grouped' as const,
      relation: 'unverified' as const,
      relationUnknownReason: 'worktree-not-verified-clean' as const,
      relationAhead: 2,
      relationBehind: 1
    }
    const result = { setups: [setup('b', { hostId: 'ssh:gpu-vm', replicaTopology: entry })] }
    const client = {
      call: async () => ({ id: 'r', ok: true, result, _meta: { runtimeId: 'rt-1' } })
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await PROJECT_HANDLERS['project setups']({
        client: client as never,
        flags: new Map([['json', true]]),
        cwd: '.',
        json: true
      })
      const printed = JSON.parse(String(log.mock.calls[0]?.[0]))
      expect(printed.result.setups[0].replicaTopology).toEqual(entry)
    } finally {
      log.mockRestore()
    }
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

describe('formatFanOutListing (row 61)', () => {
  const answered = (
    environment: string,
    runtimeId: string | null,
    setups: ProjectHostSetupWithReplicaTopology[],
    alsoReachedAs?: string[]
  ): FanOutListing['entries'][number] => ({
    outcome: 'answered',
    environment,
    runtimeId,
    setups,
    ...(alsoReachedAs ? { alsoReachedAs } : {})
  })
  const listing = (entries: FanOutListing['entries']): FanOutListing => ({
    status: 'queried',
    entries,
    queried: entries.map((entry) => entry.environment)
  })

  it('prints one section per runtime with the shared header and rows, and the queried-runtimes footer', () => {
    const text = formatFanOutListing(
      listing([
        answered('alpha', 'rt-a', [grouped('a', 'local')]),
        answered('beta', 'rt-b', [grouped('b', 'ssh:gpu-vm')])
      ])
    )
    const lines = text.split('\n')

    expect(lines[0]).toBe('alpha (runtime rt-a)')
    expect(lines[1]).toBe(REPLICA_LIST_HEADER)
    expect(lines[2]).toContain('host:local  ready  cloned  grouped  unverified  /srv/a')
    expect(lines[3]).toBe('beta (runtime rt-b)')
    expect(lines.at(-1)).toBe(
      'Queried 2 saved environments: alpha, beta. Replicas owned by Orca servers that are not saved as environments are not listed here.'
    )
  })

  it('replaces the single-runtime footer sentence in this mode', () => {
    const text = formatFanOutListing(listing([answered('alpha', 'rt-a', [grouped('a', 'local')])]))

    expect(text).not.toContain(replicaListFooter())
    expect(text).not.toContain('replicas owned by other paired Orca servers are not listed here')
  })

  it.each([
    ['unreachable', 'could not reach this Orca server'],
    ['unauthorized', 'rejected the saved pairing'],
    ['unsupported-by-host', "this server's Orca version cannot report project host setups"]
  ] as const)(
    'prints a %s runtime as its own line that says its replicas are unknown',
    (outcome, words) => {
      const text = formatFanOutListing(
        listing([
          answered('up', 'rt-up', [grouped('a', 'local')]),
          { outcome, environment: 'down', runtimeId: null }
        ])
      )

      const line = text.split('\n').find((candidate) => candidate.startsWith('down: '))
      expect(line).toContain(outcome.replaceAll('-', ' '))
      expect(line).toContain(words)
      expect(line).toContain('replicas unknown, not none')
      // Control: the answered neighbour still prints its row.
      expect(text).toContain('/srv/a')
    }
  )

  it('prints a failed runtime with its error code only', () => {
    const text = formatFanOutListing(
      listing([
        { outcome: 'failed', environment: 'odd', runtimeId: null, code: 'invalid_runtime_response' }
      ])
    )

    expect(text).toContain('odd: failed (error code invalid_runtime_response)')
    expect(text).toContain('replicas unknown, not none')
  })

  it('lists an old host with the explicit unknown words and an empty runtime as empty, not as an error', () => {
    const text = formatFanOutListing(
      listing([answered('old', 'rt-old', [setup('legacy')]), answered('bare', 'rt-bare', [])])
    )

    expect(text.match(/not reported by this host's Orca version/g)).toHaveLength(3)
    expect(text).toContain('bare (runtime rt-bare)\nNo project host setups found.')
  })

  it('says when one runtime was reached through several saved environments, and when its id is unknown', () => {
    const text = formatFanOutListing(
      listing([answered('first', 'rt-same', [], ['second']), answered('third', null, [])])
    )

    expect(text).toContain('first (runtime rt-same; also saved as: second)')
    expect(text).toContain('third (runtime id not reported)')
  })

  it('says nothing was asked when no environment is saved', () => {
    const text = formatFanOutListing({ status: 'no-saved-environments', entries: [], queried: [] })

    expect(text).toContain('No saved environments, so no other Orca server was asked.')
    expect(text).toContain('orca environment add')
    expect(text).not.toContain('Queried')
  })
})
