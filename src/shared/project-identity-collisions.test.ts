import { describe, expect, it } from 'vitest'
import { projectIdentityCollisionsFromEligibility } from './project-identity-collisions'
import { buildRootIdentityEligibility } from './project-root-identity-key'
import type { Repo } from './repo-types'

const ROOT = 'c'.repeat(40)

function repo(id: string, overrides: Partial<Repo> = {}, commonDir = `/srv/${id}/.git`): Repo {
  return {
    id,
    path: `/srv/${id}`,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 100,
    kind: 'git',
    gitRemoteIdentity: null,
    gitRootIdentity: { rootCommit: ROOT, commonDir, shallow: false },
    ...overrides
  }
}

function collisions(repos: Repo[]) {
  return projectIdentityCollisionsFromEligibility(buildRootIdentityEligibility(repos))
}

describe('project identity collisions', () => {
  it('reports one same-host-duplicate naming both setups and keeps the other host eligible', () => {
    const repos = [
      repo('laptop'),
      repo('gpu-main', { connectionId: 'gpu-vm' }),
      repo('gpu-fork', { connectionId: 'gpu-vm' })
    ]

    expect(collisions(repos)).toEqual([
      {
        kind: 'same-host-duplicate',
        rootCommit: ROOT,
        hostId: 'ssh:gpu-vm',
        setupIds: ['gpu-fork', 'gpu-main']
      }
    ])
    expect([...buildRootIdentityEligibility(repos).eligibleRepoIds]).toEqual(['laptop'])
  })

  it('does not report repos that share one commonDir', () => {
    expect(
      collisions([repo('main', {}, '/srv/main/.git'), repo('linked', {}, '/srv/main/.git')])
    ).toEqual([])
  })

  it('reports a root hint for a remote-less repo beside a remote project and never a merge', () => {
    const records = collisions([
      repo('plain'),
      repo('hosted', {
        connectionId: 'gpu-vm',
        gitRemoteIdentity: {
          canonicalKey: 'github.com/acme/widget',
          remoteName: 'origin',
          remoteUrl: 'https://github.com/acme/widget.git'
        }
      })
    ])

    expect(records).toEqual([
      {
        kind: 'shares-root-with-remote-project',
        rootCommit: ROOT,
        hostId: 'local',
        setupIds: ['plain'],
        projectIds: ['github:acme/widget']
      }
    ])
  })

  it('reports nothing for folders, settled-none and pending repos', () => {
    expect(
      collisions([
        repo('folder', { kind: 'folder' }),
        repo('none', { gitRootIdentity: null, connectionId: 'a' }),
        repo('pending', { gitRootIdentity: undefined, connectionId: 'b' })
      ])
    ).toEqual([])
  })

  it('sorts records deterministically regardless of repo order', () => {
    const other = 'd'.repeat(40)
    const mk = (id: string, root: string, host: string) =>
      repo(id, {
        connectionId: host,
        gitRootIdentity: { rootCommit: root, commonDir: `/srv/${id}/.git`, shallow: false }
      })
    const repos = [
      mk('a1', ROOT, 'h1'),
      mk('a2', ROOT, 'h1'),
      mk('b1', other, 'h2'),
      mk('b2', other, 'h2')
    ]

    expect(collisions(repos)).toEqual(
      collisions(repos.map((_, index) => repos[repos.length - 1 - index]))
    )
    expect(collisions(repos).map((record) => record.rootCommit)).toEqual([ROOT, other])
  })
})
