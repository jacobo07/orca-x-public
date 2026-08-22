import type { Project } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'

/**
 * One launcher row per project, not per checkout.
 *
 * A project can own many checkouts of the same remote — this estate has 22 of TUA-X alone. Listing
 * the raw repo catalogue makes each of them a peer of every real project, so the list answers
 * "which folders does Orca track" when the question asked was "which project am I opening".
 */
export type LauncherProjectRow = {
  /** The project's id, or the repo's own when it belongs to no project. */
  id: string
  displayName: string
  /** The checkout this row opens, so the path shown and the click cannot disagree. */
  path: string
  addedAt: number
  repoId: string
}

export type LauncherProjectList = {
  rows: LauncherProjectRow[]
  /** `recentRepoIds` translated to row ids, so recency survives the collapse. */
  recentRowIds: string[]
}

function toRow(project: Project, repo: Repo): LauncherProjectRow {
  return {
    id: project.id,
    // The project names the work; the checkout only says where this copy of it sits.
    displayName: project.displayName,
    path: repo.path,
    addedAt: repo.addedAt,
    repoId: repo.id
  }
}

/**
 * Picks the checkout a row stands for: the one most recently opened, else the earliest added.
 *
 * Why earliest as the fallback: extra checkouts are created after the original, so the oldest is
 * the one the user thinks of as the project rather than a branch-shaped copy of it.
 */
function pickRepresentativeRepo(repos: readonly Repo[], recentRank: Map<string, number>): Repo {
  return [...repos].sort((left, right) => {
    const leftRank = recentRank.get(left.id) ?? Number.POSITIVE_INFINITY
    const rightRank = recentRank.get(right.id) ?? Number.POSITIVE_INFINITY
    return leftRank - rightRank || left.addedAt - right.addedAt
  })[0]
}

export function buildLauncherProjectList({
  repos,
  projects,
  recentRepoIds
}: {
  repos: readonly Repo[]
  projects: readonly Project[]
  recentRepoIds: readonly string[]
}): LauncherProjectList {
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  const recentRank = new Map(recentRepoIds.map((repoId, index) => [repoId, index]))
  const rows: LauncherProjectRow[] = []
  const rowIdByRepoId = new Map<string, string>()

  for (const project of projects) {
    const projectRepos = project.sourceRepoIds
      .map((repoId) => repoById.get(repoId))
      .filter((repo): repo is Repo => repo !== undefined)
    // A project whose every checkout is gone has no path to show and nothing to open. Rendering it
    // would offer a row that can only fail, which is worse than the project being absent.
    if (projectRepos.length === 0) {
      continue
    }
    rows.push(toRow(project, pickRepresentativeRepo(projectRepos, recentRank)))
    for (const repo of projectRepos) {
      rowIdByRepoId.set(repo.id, project.id)
    }
  }

  // Why kept rather than dropped: the project layer is derived, and a repo it has not claimed yet is
  // still a project the user added. Omitting it would read as Orca having forgotten it.
  for (const repo of repos) {
    if (rowIdByRepoId.has(repo.id)) {
      continue
    }
    rows.push({
      id: repo.id,
      displayName: repo.displayName,
      path: repo.path,
      addedAt: repo.addedAt,
      repoId: repo.id
    })
    rowIdByRepoId.set(repo.id, repo.id)
  }

  const recentRowIds: string[] = []
  const seenRowIds = new Set<string>()
  for (const repoId of recentRepoIds) {
    const rowId = rowIdByRepoId.get(repoId)
    // Several checkouts of one project collapse to one row, so the same row can be reached more than
    // once; only its first (most recent) appearance decides where it ranks.
    if (rowId === undefined || seenRowIds.has(rowId)) {
      continue
    }
    seenRowIds.add(rowId)
    recentRowIds.push(rowId)
  }

  return { rows, recentRowIds }
}
