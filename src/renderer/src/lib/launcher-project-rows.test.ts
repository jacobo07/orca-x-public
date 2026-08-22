import { describe, expect, it } from 'vitest'
import { buildLauncherProjectList } from './launcher-project-rows'
import type { Project } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'

function makeRepo(id: string, path: string, addedAt: number): Repo {
  return { id, path, displayName: id, badgeColor: '#737373', addedAt }
}

function makeProject(id: string, displayName: string, sourceRepoIds: string[]): Project {
  return {
    id,
    displayName,
    badgeColor: '#737373',
    sourceRepoIds,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('buildLauncherProjectList', () => {
  it('collapses a project’s many checkouts into one row', () => {
    // Arrange — the shape this exists for: one project, several checkouts of the same remote.
    const repos = [
      makeRepo('tua-x', 'C:/Projects/TUA-X', 10),
      makeRepo('tua-x-qa', 'C:/Projects/TUA-X-qa', 20),
      makeRepo('tua-x-msr', 'C:/Projects/TUA-X-msr', 30)
    ]
    const projects = [makeProject('project-tua', 'TUA-X', ['tua-x', 'tua-x-qa', 'tua-x-msr'])]

    // Act
    const { rows } = buildLauncherProjectList({ repos, projects, recentRepoIds: [] })

    // Assert
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'project-tua', displayName: 'TUA-X', repoId: 'tua-x' })
  })

  it('stands for the checkout last opened, so the path shown is the one that opens', () => {
    const repos = [
      makeRepo('tua-x', 'C:/Projects/TUA-X', 10),
      makeRepo('tua-x-qa', 'C:/Projects/TUA-X-qa', 20)
    ]
    const projects = [makeProject('project-tua', 'TUA-X', ['tua-x', 'tua-x-qa'])]

    const { rows } = buildLauncherProjectList({
      repos,
      projects,
      recentRepoIds: ['tua-x-qa']
    })

    expect(rows[0]).toMatchObject({ repoId: 'tua-x-qa', path: 'C:/Projects/TUA-X-qa' })
  })

  it('ranks a project by its most recently opened checkout, listing it once', () => {
    const repos = [
      makeRepo('orca', 'C:/Projects/Orca X', 10),
      makeRepo('tua-x', 'C:/Projects/TUA-X', 20),
      makeRepo('tua-x-qa', 'C:/Projects/TUA-X-qa', 30)
    ]
    const projects = [
      makeProject('project-orca', 'Orca X', ['orca']),
      makeProject('project-tua', 'TUA-X', ['tua-x', 'tua-x-qa'])
    ]

    const { recentRowIds } = buildLauncherProjectList({
      repos,
      projects,
      recentRepoIds: ['tua-x-qa', 'orca', 'tua-x']
    })

    // 'tua-x' is the same project as 'tua-x-qa', so it must not push Orca X down a second time.
    expect(recentRowIds).toEqual(['project-tua', 'project-orca'])
  })

  it('keeps a repo the project layer has not claimed', () => {
    // A derived layer can lag; dropping the row would read as Orca forgetting a project the user
    // added rather than as the projection being a step behind.
    const repos = [makeRepo('loose', 'C:/Projects/Loose', 10)]

    const { rows, recentRowIds } = buildLauncherProjectList({
      repos,
      projects: [],
      recentRepoIds: ['loose']
    })

    expect(rows).toMatchObject([{ id: 'loose', displayName: 'loose', repoId: 'loose' }])
    expect(recentRowIds).toEqual(['loose'])
  })

  it('drops a project whose checkouts are all gone rather than offering a dead row', () => {
    const projects = [makeProject('project-ghost', 'Ghost', ['missing'])]

    const { rows } = buildLauncherProjectList({ repos: [], projects, recentRepoIds: [] })

    expect(rows).toEqual([])
  })
})
