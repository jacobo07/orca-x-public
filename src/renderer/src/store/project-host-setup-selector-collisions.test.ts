import { describe, expect, it } from 'vitest'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import type { Repo } from '../../../shared/repo-types'
import { getProjectHostSetupProjectionFromState } from './project-host-setup-selector'

const ROOT = 'a'.repeat(40)

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

const DUPLICATES = [repo('a'), repo('b')]
const EXPECTED = [
  { kind: 'same-host-duplicate', rootCommit: ROOT, hostId: 'local', setupIds: ['a', 'b'] }
]

describe('getProjectHostSetupProjectionFromState collisions', () => {
  it('carries collisions on the repo-derived branch', () => {
    const projection = getProjectHostSetupProjectionFromState({ repos: DUPLICATES })

    expect(projection.identityCollisions).toEqual(EXPECTED)
  })

  it('carries collisions on the provided branch from a store seeded with repos, projects and setups only', () => {
    const derived = projectHostSetupProjectionFromRepos(DUPLICATES)
    const state = {
      repos: DUPLICATES,
      projects: [...derived.projects],
      projectHostSetups: [...derived.setups]
    }

    const projection = getProjectHostSetupProjectionFromState(state)

    expect(projection.projects).toBe(state.projects)
    expect(projection.identityCollisions).toEqual(EXPECTED)
  })

  it('carries collisions on the merged branch (provided arrays that cover no repo)', () => {
    const projection = getProjectHostSetupProjectionFromState({
      repos: DUPLICATES,
      projects: [],
      projectHostSetups: []
    })

    expect(projection.setups.map((setup) => setup.id)).toEqual(['a', 'b'])
    expect(projection.identityCollisions).toEqual(EXPECTED)
  })

  it('carries collisions on the normalized branch (a hydrated setup under a stale project id)', () => {
    const remote = repo('c', {
      upstream: { owner: 'acme', repo: 'widget' } as Repo['upstream'],
      gitRootIdentity: undefined
    })
    const repos = [...DUPLICATES, remote]
    const derived = projectHostSetupProjectionFromRepos(repos)
    const stale = derived.setups.map((setup) =>
      setup.id === 'c' ? { ...setup, projectId: 'path:/srv/c' } : setup
    )
    const state = { repos, projects: [...derived.projects], projectHostSetups: stale }

    const projection = getProjectHostSetupProjectionFromState(state)

    expect(projection.setups.find((setup) => setup.id === 'c')?.projectId).toBe(
      'github:acme/widget'
    )
    expect(projection.identityCollisions).toEqual(EXPECTED)
  })

  it('is reference-stable per (repos, projects, setups) on every branch', () => {
    const derived = projectHostSetupProjectionFromRepos(DUPLICATES)
    const provided = {
      repos: DUPLICATES,
      projects: [...derived.projects],
      projectHostSetups: [...derived.setups]
    }
    const merged = { repos: DUPLICATES, projects: [], projectHostSetups: [] }

    for (const state of [{ repos: DUPLICATES }, provided, merged]) {
      expect(getProjectHostSetupProjectionFromState(state)).toBe(
        getProjectHostSetupProjectionFromState(state)
      )
    }
  })

  it('reports no collisions, as an empty list, when the repos hold none', () => {
    const derived = projectHostSetupProjectionFromRepos([repo('solo')])

    const projection = getProjectHostSetupProjectionFromState({
      repos: [repo('solo')],
      projects: [...derived.projects],
      projectHostSetups: [...derived.setups]
    })

    expect(projection.identityCollisions).toEqual([])
  })
})
