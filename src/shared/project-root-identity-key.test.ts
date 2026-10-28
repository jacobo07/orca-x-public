import { describe, expect, it } from 'vitest'
import { buildRootIdentityEligibility, rootIdentityProjectId } from './project-root-identity-key'
import type { Repo } from './repo-types'

const ROOT_A = 'a'.repeat(40)
const ROOT_B = 'b'.repeat(40)

function rootRepo(
  overrides: Partial<Repo> & Pick<Repo, 'id'>,
  root: string | null | 'pending' = ROOT_A,
  commonDir = `/home/u/${overrides.id}/.git`
): Repo {
  return {
    path: `/home/u/${overrides.id}`,
    displayName: overrides.id,
    badgeColor: '#737373',
    addedAt: 100,
    kind: 'git',
    gitRemoteIdentity: null,
    ...(root === 'pending'
      ? {}
      : {
          gitRootIdentity: root === null ? null : { rootCommit: root, commonDir, shallow: false }
        }),
    ...overrides
  }
}

describe('root identity eligibility', () => {
  it('makes a local and an SSH repo with one root eligible on different hosts', () => {
    const result = buildRootIdentityEligibility([
      rootRepo({ id: 'local-1' }),
      rootRepo({ id: 'ssh-1', connectionId: 'gpu-vm' })
    ])

    expect([...result.eligibleRepoIds].sort()).toEqual(['local-1', 'ssh-1'])
    expect(result.sameHostDuplicates).toEqual([])
    expect(result.sharesRootWithRemote).toEqual([])
  })

  it('excludes every candidate of a host that holds two repositories with one root', () => {
    const result = buildRootIdentityEligibility([
      rootRepo({ id: 'laptop' }),
      rootRepo({ id: 'gpu-main', connectionId: 'gpu-vm' }),
      rootRepo({ id: 'gpu-fork', connectionId: 'gpu-vm' })
    ])

    expect([...result.eligibleRepoIds]).toEqual(['laptop'])
    expect(result.sameHostDuplicates).toEqual([
      { rootCommit: ROOT_A, hostId: 'ssh:gpu-vm', setupIds: ['gpu-main', 'gpu-fork'] }
    ])
  })

  it('treats a linked worktree added as a repo (same commonDir) as one repository', () => {
    const result = buildRootIdentityEligibility([
      rootRepo({ id: 'main' }, ROOT_A, '/home/u/main/.git'),
      rootRepo({ id: 'linked', path: '/home/u/linked' }, ROOT_A, '/home/u/main/.git')
    ])

    expect([...result.eligibleRepoIds].sort()).toEqual(['linked', 'main'])
    expect(result.sameHostDuplicates).toEqual([])
  })

  it('never joins a remote-less repo to a remote project that shares its root', () => {
    const result = buildRootIdentityEligibility([
      rootRepo({ id: 'plain' }),
      rootRepo({
        id: 'forked',
        connectionId: 'gpu-vm',
        gitRemoteIdentity: {
          canonicalKey: 'github.com/acme/widget',
          remoteName: 'origin',
          remoteUrl: 'https://github.com/acme/widget.git'
        }
      })
    ])

    expect([...result.eligibleRepoIds]).toEqual([])
    expect(result.sharesRootWithRemote).toEqual([
      {
        rootCommit: ROOT_A,
        hostId: 'local',
        setupIds: ['plain'],
        projectIds: ['github:acme/widget']
      }
    ])
  })

  it('names a non-GitHub remote project by its git key', () => {
    const result = buildRootIdentityEligibility([
      rootRepo({ id: 'plain' }),
      rootRepo({
        id: 'hosted',
        gitRemoteIdentity: {
          canonicalKey: 'git.example.com/team/app',
          remoteName: 'origin',
          remoteUrl: 'https://git.example.com/team/app.git'
        }
      })
    ])

    expect(result.sharesRootWithRemote[0]?.projectIds).toEqual(['git:git.example.com/team/app'])
  })

  it('never makes a folder, a settled-none, a pending or a pending-remote repo eligible', () => {
    const result = buildRootIdentityEligibility([
      rootRepo({ id: 'folder', kind: 'folder' }),
      rootRepo({ id: 'settled-none', connectionId: 'a' }, null),
      rootRepo({ id: 'pending-root', connectionId: 'b' }, 'pending'),
      rootRepo({ id: 'pending-remote', connectionId: 'c', gitRemoteIdentity: undefined })
    ])

    expect([...result.eligibleRepoIds]).toEqual([])
    expect(result.sameHostDuplicates).toEqual([])
    expect(result.sharesRootWithRemote).toEqual([])
  })

  it('does not group two pending repos with each other', () => {
    const result = buildRootIdentityEligibility([
      rootRepo({ id: 'one' }, 'pending'),
      rootRepo({ id: 'two', connectionId: 'gpu-vm' }, 'pending')
    ])

    expect(result.eligibleRepoIds.size).toBe(0)
  })

  it('exposes the root key spelling', () => {
    expect(rootIdentityProjectId(ROOT_A)).toBe(`git-root:${ROOT_A}`)
  })

  it('keeps different roots apart', () => {
    const result = buildRootIdentityEligibility([
      rootRepo({ id: 'one' }, ROOT_A),
      rootRepo({ id: 'two' }, ROOT_B, '/home/u/two/.git')
    ])

    expect([...result.eligibleRepoIds].sort()).toEqual(['one', 'two'])
  })
})
