import { describe, expect, it } from 'vitest'
import {
  getProjectIdentityKey,
  isHostLocalProjectId,
  projectHostSetupProjectionFromRepos,
  getProjectHostSetupsForProject,
  getProjectHostSetupWorktreeMeta,
  isGitHubBackedRepo,
  getProjectIdForProviderIdentity,
  isProjectRemoteIdentityPending
} from './project-host-setup-projection'
import { buildRootIdentityEligibility } from './project-root-identity-key'
import type { Repo } from './repo-types'

function repo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'path' | 'displayName'>): Repo {
  return {
    badgeColor: '#737373',
    addedAt: 100,
    kind: 'git',
    ...overrides
  }
}

describe('project host setup projection', () => {
  it('keeps timestamps stable when addedAt is 0 across different now values', () => {
    const target = repo({
      id: 'repo-1',
      path: '/Users/alice/orca',
      displayName: 'orca',
      addedAt: 0
    })
    const first = projectHostSetupProjectionFromRepos([target], 1_000)
    const second = projectHostSetupProjectionFromRepos([target], 9_999)

    expect(first.projects[0]?.createdAt).toBe(0)
    expect(first.projects[0]?.updatedAt).toBe(0)
    expect(first.setups[0]?.createdAt).toBe(0)
    expect(second.projects[0]?.createdAt).toBe(first.projects[0]?.createdAt)
    expect(second.projects[0]?.updatedAt).toBe(first.projects[0]?.updatedAt)
    expect(second.setups[0]?.createdAt).toBe(first.setups[0]?.createdAt)
    expect(second.setups[0]?.updatedAt).toBe(first.setups[0]?.updatedAt)
  })

  // Why both orders: repo order comes from disk/host enumeration, so it must not decide the
  // project's timestamps. The accumulator carries 0 when the *first* sibling is the unknown one.
  const timestampedSibling = repo({
    id: 'local-repo',
    path: '/Users/alice/orca',
    displayName: 'Orca',
    addedAt: 100,
    upstream: { owner: 'StablyAI', repo: 'Orca' }
  })
  const unknownSibling = repo({
    id: 'remote-repo',
    path: '/home/alice/orca',
    displayName: 'orca',
    addedAt: 0,
    connectionId: 'gpu-vm',
    upstream: { owner: 'stablyai', repo: 'orca' }
  })

  it('does not wipe a persisted createdAt when a sibling repo has addedAt 0', () => {
    const projection = projectHostSetupProjectionFromRepos([timestampedSibling, unknownSibling])

    expect(projection.projects).toHaveLength(1)
    expect(projection.projects[0]?.createdAt).toBe(100)
    expect(projection.projects[0]?.updatedAt).toBe(100)
  })

  it('does not wipe a persisted createdAt when the addedAt 0 sibling comes first', () => {
    const projection = projectHostSetupProjectionFromRepos([unknownSibling, timestampedSibling])

    expect(projection.projects).toHaveLength(1)
    expect(projection.projects[0]?.createdAt).toBe(100)
    expect(projection.projects[0]?.updatedAt).toBe(100)
  })

  it('keeps per-repo setup timestamps independent of sibling order', () => {
    for (const repos of [
      [timestampedSibling, unknownSibling],
      [unknownSibling, timestampedSibling]
    ]) {
      const { setups } = projectHostSetupProjectionFromRepos(repos)
      const timestamped = setups.find((setup) => setup.repoId === 'local-repo')
      const unknown = setups.find((setup) => setup.repoId === 'remote-repo')
      expect(timestamped?.createdAt).toBe(100)
      expect(timestamped?.updatedAt).toBe(100)
      // Setups are per repo and never merged, so the unknown one keeps its own 0 either way.
      expect(unknown?.createdAt).toBe(0)
      expect(unknown?.updatedAt).toBe(0)
    }
  })

  it('projects a legacy local repo into one project and one ready local setup', () => {
    const projection = projectHostSetupProjectionFromRepos(
      [repo({ id: 'repo-1', path: '/Users/alice/orca', displayName: 'orca' })],
      500
    )

    expect(projection.projects).toEqual([
      {
        id: 'repo:repo-1',
        displayName: 'orca',
        badgeColor: '#737373',
        kind: 'git',
        sourceRepoIds: ['repo-1'],
        createdAt: 100,
        updatedAt: 100
      }
    ])
    expect(projection.setups).toEqual([
      {
        id: 'repo-1',
        projectId: 'repo:repo-1',
        hostId: 'local',
        repoId: 'repo-1',
        path: '/Users/alice/orca',
        displayName: 'orca',
        kind: 'git',
        setupState: 'ready',
        setupMethod: 'legacy-repo',
        createdAt: 100,
        updatedAt: 100
      }
    ])
  })

  it('preserves host-local setup fields on SSH repos', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'remote-repo',
        path: '/home/alice/orca',
        displayName: 'orca',
        connectionId: 'openclaw 2',
        worktreeBasePath: '../worktrees',
        gitUsername: 'alice'
      })
    ])

    expect(projection.setups[0]).toMatchObject({
      id: 'remote-repo',
      hostId: 'ssh:openclaw%202',
      connectionId: 'openclaw 2',
      worktreeBasePath: '../worktrees',
      gitUsername: 'alice'
    })
  })

  it('preserves repo-backed setup method metadata', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'repo-1',
        path: '/Users/alice/orca',
        displayName: 'orca',
        projectHostSetupMethod: 'cloned'
      })
    ])

    expect(projection.setups[0]?.setupMethod).toBe('cloned')
  })

  it('groups repo checkouts with the same provider identity under one project', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'local-repo',
        path: '/Users/alice/orca',
        displayName: 'Orca',
        upstream: { owner: 'StablyAI', repo: 'Orca' }
      }),
      repo({
        id: 'remote-repo',
        path: '/home/alice/orca',
        displayName: 'orca',
        connectionId: 'gpu-vm',
        upstream: { owner: 'stablyai', repo: 'orca' }
      })
    ])

    expect(projection.projects).toHaveLength(1)
    expect(projection.projects[0]).toMatchObject({
      id: 'github:stablyai/orca',
      sourceRepoIds: ['local-repo', 'remote-repo'],
      providerIdentity: { provider: 'github', owner: 'StablyAI', repo: 'Orca' }
    })
    expect(getProjectHostSetupsForProject(projection.setups, 'github:stablyai/orca')).toHaveLength(
      2
    )
  })

  it('keeps same-named github.com and GHES repositories in separate projects', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'dotcom-repo',
        path: '/work/dotcom',
        displayName: 'widgets',
        upstream: { owner: 'acme', repo: 'widgets', host: 'github.com' }
      }),
      repo({
        id: 'enterprise-repo',
        path: '/work/enterprise',
        displayName: 'widgets',
        upstream: { owner: 'acme', repo: 'widgets', host: 'github.acme.test' }
      })
    ])

    expect(projection.projects).toHaveLength(2)
    expect(projection.projects.map((project) => project.id)).toEqual([
      'github:acme/widgets',
      'github:github.acme.test/acme/widgets'
    ])
    expect(projection.projects[1]?.providerIdentity).toEqual({
      provider: 'github',
      owner: 'acme',
      repo: 'widgets',
      host: 'github.acme.test'
    })
  })

  it('groups GHES icon identities only when their hosts match', () => {
    const enterpriseIcon = (host: string) => ({
      type: 'image' as const,
      src: `https://${host}/acme.png?size=64`,
      source: 'github' as const,
      label: 'acme/widgets'
    })
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'enterprise-local',
        path: '/work/local',
        displayName: 'widgets',
        repoIcon: enterpriseIcon('github.acme.test')
      }),
      repo({
        id: 'enterprise-ssh',
        path: '/work/ssh',
        displayName: 'widgets',
        connectionId: 'builder',
        repoIcon: enterpriseIcon('github.acme.test')
      }),
      repo({
        id: 'other-enterprise',
        path: '/work/other',
        displayName: 'widgets',
        repoIcon: enterpriseIcon('github.other.test')
      })
    ])

    expect(projection.projects).toHaveLength(2)
    expect(projection.projects[0]).toMatchObject({
      id: 'github:github.acme.test/acme/widgets',
      sourceRepoIds: ['enterprise-local', 'enterprise-ssh']
    })
    expect(projection.projects[1]?.id).toBe('github:github.other.test/acme/widgets')
  })

  it('uses GitHub repo icon metadata as a provider identity fallback', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'local-repo',
        path: '/Users/alice/orca',
        displayName: 'Orca',
        repoIcon: {
          type: 'image',
          src: 'https://github.com/stablyai.png?size=64',
          source: 'github',
          label: 'stablyai/orca'
        }
      }),
      repo({
        id: 'remote-repo',
        path: '/home/alice/orca',
        displayName: 'orca',
        connectionId: 'gpu-vm',
        repoIcon: {
          type: 'image',
          src: 'https://github.com/stablyai.png?size=64',
          source: 'github',
          label: 'StablyAI/Orca'
        }
      })
    ])

    expect(projection.projects).toHaveLength(1)
    expect(projection.projects[0]).toMatchObject({
      id: 'github:stablyai/orca',
      sourceRepoIds: ['local-repo', 'remote-repo'],
      providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
    })
    expect(getProjectHostSetupsForProject(projection.setups, 'github:stablyai/orca')).toHaveLength(
      2
    )
  })

  it('uses git remote identity as a provider identity fallback', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'canonical-local-repo',
        path: '/Users/alice/stably/orca',
        displayName: 'orca',
        gitRemoteIdentity: {
          canonicalKey: 'github.com/stablyai/orca',
          remoteName: 'origin',
          remoteUrl: 'git@github.com:stablyai/orca.git'
        }
      }),
      repo({
        id: 'old-branch-checkout',
        path: '/Users/alice/orca/workspaces/orca/re-enable-webgl-for-remote-runtime-terminals',
        displayName: 're-enable-webgl-for-remote-runtime-terminals',
        repoIcon: {
          type: 'image',
          src: 'https://github.com/stablyai.png?size=64',
          source: 'github',
          label: 'stablyai/orca'
        }
      })
    ])

    expect(projection.projects).toHaveLength(1)
    expect(projection.projects[0]).toMatchObject({
      id: 'github:stablyai/orca',
      displayName: 'orca',
      sourceRepoIds: ['canonical-local-repo', 'old-branch-checkout'],
      providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
    })
  })

  it('uses a GHES canonical remote identity when the remote URL is unavailable', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'enterprise-repo',
        path: '/work/widgets',
        displayName: 'widgets',
        gitRemoteIdentity: {
          canonicalKey: 'github.acme.test/acme/widgets',
          remoteName: 'origin',
          remoteUrl: 'not-a-remote'
        }
      })
    ])

    expect(projection.projects[0]).toMatchObject({
      id: 'github:github.acme.test/acme/widgets',
      providerIdentity: {
        provider: 'github',
        owner: 'acme',
        repo: 'widgets',
        host: 'github.acme.test'
      }
    })
  })

  it('preserves GHES HTTP ports but drops SSH transport ports from remote identity', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'https-repo',
        path: '/work/https',
        displayName: 'widgets',
        gitRemoteIdentity: {
          canonicalKey: 'github.acme.test/acme/widgets',
          remoteName: 'origin',
          remoteUrl: 'https://github.acme.test:8443/acme/widgets.git'
        }
      }),
      repo({
        id: 'ssh-repo',
        path: '/work/ssh',
        displayName: 'widgets',
        gitRemoteIdentity: {
          canonicalKey: 'github.acme.test/acme/widgets',
          remoteName: 'origin',
          remoteUrl: 'ssh://git@github.acme.test:2222/acme/widgets.git'
        }
      })
    ])

    expect(projection.projects.map((project) => project.providerIdentity?.host)).toEqual([
      'github.acme.test:8443',
      'github.acme.test'
    ])
  })

  it('does not guess that same-named folders are the same project without identity', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({ id: 'local-repo', path: '/Users/alice/app', displayName: 'app' }),
      repo({
        id: 'remote-repo',
        path: '/srv/app',
        displayName: 'app',
        connectionId: 'work-server'
      })
    ])

    expect(projection.projects.map((project) => project.id)).toEqual([
      'repo:local-repo',
      'repo:remote-repo'
    ])
  })

  it('groups same-project records across local, SSH, and runtime hosts by git remote identity', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'local-sample-app',
        path: '/Users/alice/work/sample-app',
        displayName: 'sample-app',
        gitRemoteIdentity: {
          canonicalKey: 'git.company.test/team/sample-app',
          remoteName: 'origin',
          remoteUrl: 'git@git.company.test:team/sample-app.git'
        }
      }),
      repo({
        id: 'ssh-sample-app',
        path: '/home/alice/src/sample-app',
        displayName: 'sample-app',
        connectionId: 'build server',
        gitRemoteIdentity: {
          canonicalKey: 'git.company.test/team/sample-app',
          remoteName: 'origin',
          remoteUrl: 'https://git.company.test/team/sample-app.git'
        }
      }),
      repo({
        id: 'runtime-sample-app',
        path: '/workspace/sample-app',
        displayName: 'sample-app',
        executionHostId: 'runtime:dev-container',
        gitRemoteIdentity: {
          canonicalKey: 'git.company.test/team/sample-app',
          remoteName: 'origin',
          remoteUrl: 'ssh://git@git.company.test/team/sample-app.git'
        }
      })
    ])

    expect(projection.projects).toHaveLength(1)
    expect(projection.projects[0]).toMatchObject({
      id: 'git:git.company.test/team/sample-app',
      displayName: 'sample-app',
      sourceRepoIds: ['local-sample-app', 'ssh-sample-app', 'runtime-sample-app'],
      gitRemoteIdentity: {
        canonicalKey: 'git.company.test/team/sample-app',
        remoteName: 'origin'
      }
    })
    expect(projection.setups.map((setup) => setup.hostId)).toEqual([
      'local',
      'ssh:build%20server',
      'runtime:dev-container'
    ])
    expect(
      getProjectHostSetupsForProject(projection.setups, 'git:git.company.test/team/sample-app')
    ).toHaveLength(3)
  })

  it('keeps same-named cross-host records separate when there is no shared repo identity', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'local-sample-app',
        path: '/Users/alice/work/sample-app',
        displayName: 'sample-app'
      }),
      repo({
        id: 'ssh-sample-app',
        path: '/srv/unrelated/sample-app',
        displayName: 'sample-app',
        connectionId: 'staging server'
      }),
      repo({
        id: 'runtime-sample-app',
        path: '/workspace/sample-app',
        displayName: 'sample-app',
        executionHostId: 'runtime:preview'
      })
    ])

    // Why: display names are labels, not identity. A future fix needs a
    // normalized git remote identity or an explicit user link before merging.
    expect(projection.projects).toHaveLength(3)
  })

  it('does not collapse case-distinct remote paths for self-hosted git remotes', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'uppercase-repo',
        path: '/Users/alice/work/sample-app',
        displayName: 'sample-app',
        gitRemoteIdentity: {
          canonicalKey: 'git.company.test/Team/Sample-App',
          remoteName: 'origin',
          remoteUrl: 'git@git.company.test:Team/Sample-App.git'
        }
      }),
      repo({
        id: 'lowercase-repo',
        path: '/home/alice/src/sample-app',
        displayName: 'sample-app',
        connectionId: 'build server',
        gitRemoteIdentity: {
          canonicalKey: 'git.company.test/team/sample-app',
          remoteName: 'origin',
          remoteUrl: 'git@git.company.test:team/sample-app.git'
        }
      })
    ])

    expect(projection.projects.map((project) => project.id)).toEqual([
      'git:git.company.test/Team/Sample-App',
      'git:git.company.test/team/sample-app'
    ])
  })

  it('ignores malformed provider identity values', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'repo-1',
        path: '/Users/alice/orca',
        displayName: 'orca',
        upstream: { owner: 'stablyai', repo: 42 } as never
      })
    ])

    expect(projection.projects[0]?.id).toBe('repo:repo-1')
    expect(projection.projects[0]?.providerIdentity).toBeUndefined()
  })

  it('derives workspace ownership metadata from the repo setup', () => {
    const targetRepo = repo({
      id: 'remote-repo',
      path: '/home/alice/orca',
      displayName: 'orca',
      connectionId: 'openclaw 2',
      upstream: { owner: 'stablyai', repo: 'orca' }
    })
    const projection = projectHostSetupProjectionFromRepos([targetRepo])

    expect(getProjectHostSetupWorktreeMeta(projection.setups, targetRepo)).toEqual({
      projectId: 'github:stablyai/orca',
      hostId: 'ssh:openclaw%202',
      projectHostSetupId: 'remote-repo'
    })
  })
})

describe('isGitHubBackedRepo', () => {
  it('is true when an explicit upstream owner/repo is present', () => {
    const target = repo({
      id: 'r',
      path: '/r',
      displayName: 'r',
      upstream: { owner: 'stablyai', repo: 'orca' }
    })
    expect(isGitHubBackedRepo(target)).toBe(true)
  })

  it('is true when a GitHub-sourced avatar icon encodes the slug', () => {
    const target = repo({
      id: 'r',
      path: '/r',
      displayName: 'r',
      repoIcon: {
        type: 'image',
        src: 'https://github.com/stablyai.png?size=64',
        source: 'github',
        label: 'stablyai/orca'
      }
    })
    expect(isGitHubBackedRepo(target)).toBe(true)
  })

  it('is false for a non-GitHub icon and no upstream (GitLab/folder)', () => {
    const target = repo({
      id: 'r',
      path: '/r',
      displayName: 'r',
      repoIcon: { type: 'lucide', name: 'gitlab' }
    })
    expect(isGitHubBackedRepo(target)).toBe(false)
  })

  it('is false for a plain local repo with no provider signal', () => {
    expect(isGitHubBackedRepo(repo({ id: 'r', path: '/r', displayName: 'r' }))).toBe(false)
  })
})

describe('getProjectIdForProviderIdentity', () => {
  it('uses the same normalized identity key as project projection', () => {
    expect(
      getProjectIdForProviderIdentity({ provider: 'github', owner: 'PyTorch', repo: 'PyTorch' })
    ).toBe('github:pytorch/pytorch')
    expect(
      getProjectIdForProviderIdentity({
        provider: 'github',
        owner: 'Acme',
        repo: 'Orca',
        host: 'GITHUB.ACME.TEST:8443'
      })
    ).toBe('github:github.acme.test:8443/acme/orca')
  })
})

describe('isProjectRemoteIdentityPending', () => {
  const base = { id: 'r', path: '/r', displayName: 'r' } as const

  it('is true while the background remote probe has not answered', () => {
    expect(isProjectRemoteIdentityPending(repo({ ...base }))).toBe(true)
    expect(isProjectRemoteIdentityPending(repo({ ...base, connectionId: 'builder' }))).toBe(true)
  })

  it('is false once the probe settles on no usable remote', () => {
    expect(isProjectRemoteIdentityPending(repo({ ...base, gitRemoteIdentity: null }))).toBe(false)
  })

  it('is false once any provider-neutral identity resolves', () => {
    expect(
      isProjectRemoteIdentityPending(
        repo({
          ...base,
          gitRemoteIdentity: {
            canonicalKey: 'gitlab.example.com/team/orca',
            remoteName: 'origin',
            remoteUrl: 'git@gitlab.example.com:team/orca.git'
          }
        })
      )
    ).toBe(false)
    expect(
      isProjectRemoteIdentityPending(
        repo({ ...base, upstream: { owner: 'stablyai', repo: 'orca' } })
      )
    ).toBe(false)
  })
})

describe('derived project identity stability', () => {
  const base = { id: 'r', path: '/r', displayName: 'r' } as const

  // Why pinned: this id is the persisted Project primary key, so folding a host alias here would
  // silently re-key existing projects on upgrade and drop their runtime preference.
  it('keeps a www. remote provider-neutral instead of folding it onto github.com', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        ...base,
        gitRemoteIdentity: {
          canonicalKey: 'www.github.com/acme/app',
          remoteName: 'origin',
          remoteUrl: 'https://www.github.com/acme/app.git'
        }
      })
    ])
    expect(projection.projects.map((project) => project.id)).toEqual([
      'git:www.github.com/acme/app'
    ])
  })

  it('still folds the documented ssh.github.com alias onto github.com', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        ...base,
        gitRemoteIdentity: {
          canonicalKey: 'ssh.github.com/acme/app',
          remoteName: 'origin',
          remoteUrl: 'ssh://git@ssh.github.com:443/acme/app.git'
        }
      })
    ])
    expect(projection.projects.map((project) => project.id)).toEqual(['github:acme/app'])
  })
})

describe('git-root project identity', () => {
  const ROOT = 'a'.repeat(40)
  const OTHER_ROOT = 'b'.repeat(40)

  function rooted(
    id: string,
    overrides: Partial<Repo> = {},
    rootCommit = ROOT,
    commonDir = `/srv/${id}/.git`
  ): Repo {
    return repo({
      id,
      path: `/srv/${id}`,
      displayName: id,
      gitRemoteIdentity: null,
      gitRootIdentity: { rootCommit, commonDir, shallow: false },
      ...overrides
    })
  }

  it('derives one project with two setups for a remote-less repo replicated on two hosts', () => {
    const projection = projectHostSetupProjectionFromRepos([
      rooted('laptop'),
      rooted('gpu', { connectionId: 'gpu-vm' })
    ])

    expect(projection.projects.map((project) => project.id)).toEqual([`git-root:${ROOT}`])
    expect(projection.projects[0]?.sourceRepoIds).toEqual(['laptop', 'gpu'])
    expect(projection.setups.map((setup) => [setup.id, setup.hostId, setup.projectId])).toEqual([
      ['laptop', 'local', `git-root:${ROOT}`],
      ['gpu', 'ssh:gpu-vm', `git-root:${ROOT}`]
    ])
    expect(projection.identityCollisions).toEqual([])
  })

  it('keeps a same-host duplicate apart, reports it once, and lets the other host keep the key', () => {
    const projection = projectHostSetupProjectionFromRepos([
      rooted('laptop'),
      rooted('gpu-main', { connectionId: 'gpu-vm' }),
      rooted('gpu-fork', { connectionId: 'gpu-vm' })
    ])

    expect(projection.setups.map((setup) => [setup.id, setup.projectId])).toEqual([
      ['laptop', `git-root:${ROOT}`],
      ['gpu-main', 'repo:gpu-main'],
      ['gpu-fork', 'repo:gpu-fork']
    ])
    expect(
      projection.projects.find((project) => project.id === `git-root:${ROOT}`)?.sourceRepoIds
    ).toEqual(['laptop'])
    expect(projection.identityCollisions).toEqual([
      {
        kind: 'same-host-duplicate',
        rootCommit: ROOT,
        hostId: 'ssh:gpu-vm',
        setupIds: ['gpu-fork', 'gpu-main']
      }
    ])
  })

  it('groups a linked worktree added as a repo with its main repository, without a record', () => {
    const projection = projectHostSetupProjectionFromRepos([
      rooted('main', {}, ROOT, '/srv/main/.git'),
      rooted('linked', { path: '/srv/linked' }, ROOT, '/srv/main/.git')
    ])

    expect(projection.projects.map((project) => project.id)).toEqual([`git-root:${ROOT}`])
    expect(projection.identityCollisions).toEqual([])
  })

  it('never joins a remote-less repo to a remote project that shares its root', () => {
    const projection = projectHostSetupProjectionFromRepos([
      rooted('plain'),
      rooted('hosted', {
        connectionId: 'gpu-vm',
        gitRemoteIdentity: {
          canonicalKey: 'git.example.com/team/app',
          remoteName: 'origin',
          remoteUrl: 'https://git.example.com/team/app.git'
        }
      })
    ])

    expect(projection.projects.map((project) => project.id).sort()).toEqual([
      'git:git.example.com/team/app',
      'repo:plain'
    ])
    expect(projection.identityCollisions).toEqual([
      {
        kind: 'shares-root-with-remote-project',
        rootCommit: ROOT,
        hostId: 'local',
        setupIds: ['plain'],
        projectIds: ['git:git.example.com/team/app']
      }
    ])
  })

  it('keeps provider and git remote identity above the root identity', () => {
    const projection = projectHostSetupProjectionFromRepos([
      rooted('github', { upstream: { owner: 'acme', repo: 'widget' } })
    ])

    expect(projection.projects.map((project) => project.id)).toEqual(['github:acme/widget'])
  })

  it('derives repo: for pending, settled-none and folder repos', () => {
    const projection = projectHostSetupProjectionFromRepos([
      rooted('pending', { gitRootIdentity: undefined }),
      rooted('none', { gitRootIdentity: null, connectionId: 'a' }),
      rooted('folder', { kind: 'folder', connectionId: 'b' }),
      rooted('pending-remote', { gitRemoteIdentity: undefined, connectionId: 'c' })
    ])

    expect(projection.setups.map((setup) => setup.projectId)).toEqual([
      'repo:pending',
      'repo:none',
      'repo:folder',
      'repo:pending-remote'
    ])
  })

  it('returns repo: from getProjectIdentityKey when no eligibility is supplied', () => {
    const resolved = rooted('lone')

    expect(getProjectIdentityKey(resolved)).toBe('repo:lone')
    expect(getProjectIdentityKey(resolved, new Set(['lone']))).toBe(`git-root:${ROOT}`)
    expect(getProjectIdentityKey(resolved, new Set())).toBe('repo:lone')
  })

  it('judges a projected subset against the full context, and a lone repo against none', () => {
    const laptop = rooted('laptop')
    const gpuMain = rooted('gpu-main', { connectionId: 'gpu-vm' })
    const gpuFork = rooted('gpu-fork', { connectionId: 'gpu-vm' })
    const all = [laptop, gpuMain, gpuFork]

    // The collision is only visible in the context: the shown subset holds one GPU repo.
    const subset = projectHostSetupProjectionFromRepos([laptop, gpuMain], undefined, {
      identityContext: all
    })
    const blind = projectHostSetupProjectionFromRepos([laptop, gpuMain])
    const conservative = projectHostSetupProjectionFromRepos([laptop, gpuMain], undefined, {
      identityContext: []
    })

    expect(subset.setups.map((setup) => setup.projectId)).toEqual([
      `git-root:${ROOT}`,
      'repo:gpu-main'
    ])
    expect(blind.setups.map((setup) => setup.projectId)).toEqual([
      `git-root:${ROOT}`,
      `git-root:${ROOT}`
    ])
    expect(conservative.setups.map((setup) => setup.projectId)).toEqual([
      'repo:laptop',
      'repo:gpu-main'
    ])
    expect(subset.identityCollisions).toHaveLength(1)
  })

  it('keeps roots apart and leaves the host-local predicate on repo: only', () => {
    const projection = projectHostSetupProjectionFromRepos([
      rooted('one'),
      rooted('two', { connectionId: 'gpu-vm' }, OTHER_ROOT)
    ])

    expect(projection.projects).toHaveLength(2)
    expect(isHostLocalProjectId('repo:one')).toBe(true)
    expect(isHostLocalProjectId(`git-root:${ROOT}`)).toBe(false)
    expect(buildRootIdentityEligibility([rooted('one')]).eligibleRepoIds.has('one')).toBe(true)
  })
})
