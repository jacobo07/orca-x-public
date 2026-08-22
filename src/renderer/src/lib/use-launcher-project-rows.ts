import { useMemo } from 'react'
import { useAppStore } from '../store'
import { buildLauncherProjectList, type LauncherProjectRow } from './launcher-project-rows'
import { filterProjectsByQuery, orderProjectsByRecency } from './recent-project-order'

/**
 * The launcher's rows, ordered and filtered.
 *
 * Shared so the list and the "no project matches" message are computed once. Two callers deriving
 * this separately is how a launcher ends up claiming nothing matches above a list of matches.
 */
export function useLauncherProjectRows(query: string): LauncherProjectRow[] {
  const repos = useAppStore((s) => s.repos)
  const projects = useAppStore((s) => s.projects)
  const recentProjectIds = useAppStore((s) => s.recentProjectIds)

  return useMemo(() => {
    const { rows, recentRowIds } = buildLauncherProjectList({
      repos,
      projects,
      recentRepoIds: recentProjectIds
    })
    return filterProjectsByQuery(orderProjectsByRecency(rows, recentRowIds), query)
  }, [projects, query, recentProjectIds, repos])
}
