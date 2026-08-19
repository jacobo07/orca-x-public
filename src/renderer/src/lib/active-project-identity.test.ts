import { describe, it, expect } from 'vitest'
import { resolveActiveProjectIdentity } from './active-project-identity'

const REPOS = [
  { id: 'repo-a', displayName: 'Orca' },
  { id: 'repo-b', displayName: 'Sidecar' }
]

describe('resolveActiveProjectIdentity', () => {
  it('names the project the active repo pointer selects', () => {
    // Arrange / Act
    const identity = resolveActiveProjectIdentity({
      activeRepoId: 'repo-b',
      activeWorktreeId: 'repo-a::/a',
      repos: REPOS
    })

    // Assert — the repo pointer wins over a worktree that has not caught up.
    expect(identity).toEqual({ repoId: 'repo-b', displayName: 'Sidecar' })
  })

  it('falls back to the active worktree while the repo pointer is unset', () => {
    // Arrange / Act
    const identity = resolveActiveProjectIdentity({
      activeRepoId: null,
      activeWorktreeId: 'repo-a::/a',
      repos: REPOS
    })

    // Assert
    expect(identity).toEqual({ repoId: 'repo-a', displayName: 'Orca' })
  })

  it('names nothing when no project is active', () => {
    // Arrange / Act
    const identity = resolveActiveProjectIdentity({
      activeRepoId: null,
      activeWorktreeId: null,
      repos: REPOS
    })

    // Assert
    expect(identity).toBeNull()
  })

  it('names nothing for a repo the catalog has not loaded', () => {
    // Arrange / Act — activation can precede repo hydration.
    const identity = resolveActiveProjectIdentity({
      activeRepoId: 'repo-unknown',
      activeWorktreeId: null,
      repos: REPOS
    })

    // Assert — a blank title beats a wrong one.
    expect(identity).toBeNull()
  })
})
