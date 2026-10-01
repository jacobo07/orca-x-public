import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitRootProbeResult } from '../shared/git-root-identity'
import type { Repo } from '../shared/repo-types'

const probeMock = vi.hoisted(() => vi.fn())
const remoteProbeMock = vi.hoisted(() => vi.fn())
vi.mock('./repo-git-root-identity', () => ({ probeGitRootIdentity: probeMock }))
vi.mock('./repo-git-remote-identity', () => ({ probeGitRemoteIdentity: remoteProbeMock }))

import { buildRootIdentityEligibility } from '../shared/project-root-identity-key'
import { linkRepoToRootProject } from './project-root-identity-link'

const ROOT = 'e'.repeat(40)
const OTHER_ROOT = 'f'.repeat(40)

function resolved(rootCommit: string, commonDir: string): GitRootProbeResult {
  return { status: 'resolved', identity: { rootCommit, commonDir, shallow: false } }
}

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/srv/${id}`,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

function fakeStore(repos: Repo[]) {
  return {
    getRepos: () => repos,
    updateRepo: vi.fn((id: string, updates: Partial<Repo>) => {
      const target = repos.find((entry) => entry.id === id)
      if (!target) {
        return null
      }
      Object.assign(target, updates)
      return { ...target }
    })
  }
}

async function refusalOf(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise
  } catch (error) {
    return error as { code?: string; message: string }
  }
  throw new Error('expected a refusal')
}

beforeEach(() => {
  probeMock.mockReset()
  remoteProbeMock.mockReset().mockResolvedValue({ status: 'no-remote' })
})

describe('linkRepoToRootProject', () => {
  it('does nothing for a project id that is not a git-root id', async () => {
    const target = repo('new')
    const store = fakeStore([target])

    await linkRepoToRootProject(store as never, target, 'github:acme/widget')
    await linkRepoToRootProject(store as never, target, `repo:${target.id}`)

    expect(probeMock).not.toHaveBeenCalled()
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('writes the probed root when it equals the requested project root', async () => {
    const target = repo('new', { connectionId: 'gpu-vm' })
    const store = fakeStore([target])
    probeMock.mockResolvedValue(resolved(ROOT, '/srv/new/.git'))

    await linkRepoToRootProject(store as never, target, `git-root:${ROOT}`)

    expect(probeMock).toHaveBeenCalledWith('/srv/new', 'gpu-vm')
    expect(remoteProbeMock).toHaveBeenCalledWith('/srv/new', 'gpu-vm')
    // Why one write: root and settled remote land together, so the repo is never half-eligible.
    expect(store.updateRepo).toHaveBeenCalledTimes(1)
    expect(store.updateRepo).toHaveBeenCalledWith('new', {
      gitRootIdentity: { rootCommit: ROOT, commonDir: '/srv/new/.git', shallow: false },
      gitRootIdentityNoneReason: undefined,
      gitRemoteIdentity: null
    })
    expect(buildRootIdentityEligibility(store.getRepos()).eligibleRepoIds.has('new')).toBe(true)
  })

  it('refuses root_identity_unavailable when the remote probe cannot reach git, never writing null', async () => {
    const target = repo('new', { connectionId: 'gpu-vm' })
    const store = fakeStore([target])
    const before = structuredClone([target])
    probeMock.mockResolvedValue(resolved(ROOT, '/srv/new/.git'))
    remoteProbeMock.mockResolvedValue({ status: 'unavailable' })

    const refusal = await refusalOf(
      linkRepoToRootProject(store as never, target, `git-root:${ROOT}`)
    )

    expect(refusal.code).toBe('root_identity_unavailable')
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(store.getRepos()).toEqual(before)
  })

  it('refuses root_identity_has_remote when the folder has a usable remote', async () => {
    const target = repo('new')
    const store = fakeStore([target])
    probeMock.mockResolvedValue(resolved(ROOT, '/srv/new/.git'))
    remoteProbeMock.mockResolvedValue({
      status: 'resolved',
      identity: {
        canonicalKey: 'git.example.test/acme/widget',
        remoteName: 'origin',
        remoteUrl: 'git@git.example.test:acme/widget.git'
      }
    })

    const refusal = await refusalOf(
      linkRepoToRootProject(store as never, target, `git-root:${ROOT}`)
    )

    expect(refusal.code).toBe('root_identity_has_remote')
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('refuses root_identity_has_remote when a resolved remote is already recorded, even if git now says none', async () => {
    const target = repo('new', {
      gitRemoteIdentity: {
        canonicalKey: 'git.example.test/acme/widget',
        remoteName: 'origin',
        remoteUrl: 'git@git.example.test:acme/widget.git'
      }
    })
    const store = fakeStore([target])
    probeMock.mockResolvedValue(resolved(ROOT, '/srv/new/.git'))

    const refusal = await refusalOf(
      linkRepoToRootProject(store as never, target, `git-root:${ROOT}`)
    )

    expect(refusal.code).toBe('root_identity_has_remote')
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('refuses root_identity_unavailable when the host cannot answer', async () => {
    const target = repo('new')
    const store = fakeStore([target])
    const before = structuredClone([target])
    probeMock.mockResolvedValue({ status: 'unavailable' })

    const refusal = await refusalOf(
      linkRepoToRootProject(store as never, target, `git-root:${ROOT}`)
    )

    expect(refusal.code).toBe('root_identity_unavailable')
    expect(refusal.message).toMatch(/^root_identity_unavailable: /)
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(store.getRepos()).toEqual(before)
  })

  it.each(['unborn', 'shallow', 'malformed'] as const)(
    'refuses root_identity_absent for a settled-none (%s) folder',
    async (reason) => {
      const target = repo('new')
      const store = fakeStore([target])
      probeMock.mockResolvedValue({ status: 'settled-none', reason })

      const refusal = await refusalOf(
        linkRepoToRootProject(store as never, target, `git-root:${ROOT}`)
      )

      expect(refusal.code).toBe('root_identity_absent')
      expect(store.updateRepo).not.toHaveBeenCalled()
    }
  )

  it('refuses root_identity_absent for a folder workspace without probing it', async () => {
    const target = repo('new', { kind: 'folder' })
    const store = fakeStore([target])

    const refusal = await refusalOf(
      linkRepoToRootProject(store as never, target, `git-root:${ROOT}`)
    )

    expect(refusal.code).toBe('root_identity_absent')
    expect(probeMock).not.toHaveBeenCalled()
    expect(remoteProbeMock).not.toHaveBeenCalled()
  })

  it('refuses root_identity_mismatch when the folder starts from a different commit', async () => {
    const target = repo('new')
    const store = fakeStore([target])
    probeMock.mockResolvedValue(resolved(OTHER_ROOT, '/srv/new/.git'))

    const refusal = await refusalOf(
      linkRepoToRootProject(store as never, target, `git-root:${ROOT}`)
    )

    expect(refusal.code).toBe('root_identity_mismatch')
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('refuses root_identity_collision when the host holds another repository with that root', async () => {
    const held = repo('held', {
      gitRemoteIdentity: null,
      gitRootIdentity: { rootCommit: ROOT, commonDir: '/srv/held/.git', shallow: false }
    })
    const target = repo('new')
    const store = fakeStore([held, target])
    const before = structuredClone(store.getRepos())
    probeMock.mockResolvedValue(resolved(ROOT, '/srv/new/.git'))

    const refusal = await refusalOf(
      linkRepoToRootProject(store as never, target, `git-root:${ROOT}`)
    )

    expect(refusal.code).toBe('root_identity_collision')
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(store.getRepos()).toEqual(before)
  })

  it('links a linked worktree of the repository the host already holds', async () => {
    const held = repo('held', {
      gitRemoteIdentity: null,
      gitRootIdentity: { rootCommit: ROOT, commonDir: '/srv/held/.git', shallow: false }
    })
    const target = repo('linked')
    const store = fakeStore([held, target])
    probeMock.mockResolvedValue(resolved(ROOT, '/srv/held/.git'))

    await linkRepoToRootProject(store as never, target, `git-root:${ROOT}`)

    expect(store.updateRepo).toHaveBeenCalledTimes(1)
  })

  it('does not treat the same root on another host as a collision', async () => {
    const elsewhere = repo('elsewhere', {
      connectionId: 'other-vm',
      gitRemoteIdentity: null,
      gitRootIdentity: { rootCommit: ROOT, commonDir: '/srv/elsewhere/.git', shallow: false }
    })
    const target = repo('new')
    const store = fakeStore([elsewhere, target])
    probeMock.mockResolvedValue(resolved(ROOT, '/srv/new/.git'))

    await linkRepoToRootProject(store as never, target, `git-root:${ROOT}`)

    expect(store.updateRepo).toHaveBeenCalledTimes(1)
  })
})
