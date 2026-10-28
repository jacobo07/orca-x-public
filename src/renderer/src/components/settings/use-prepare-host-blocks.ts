import { useMemo } from 'react'
import type { Repo } from '../../../../shared/repo-types'
import { useAppStore } from '../../store'
import { getProjectHostSetupProjectionFromState } from '../../store/selectors'
import { selectPrepareHostBlocks, type PrepareHostBlockSpec } from './prepare-host-blocks'

export function usePrepareHostBlocks(
  repo: Repo,
  selectedProjectSetupId?: string
): PrepareHostBlockSpec[] {
  const projection = useAppStore((state) => getProjectHostSetupProjectionFromState(state))
  return useMemo(() => {
    const own = projection.setups.find((setup) => setup.repoId === repo.id)
    const setups = own ? projection.setups.filter((setup) => setup.projectId === own.projectId) : []
    return selectPrepareHostBlocks({ repo, setups, selectedSetupId: selectedProjectSetupId })
  }, [projection, repo, selectedProjectSetupId])
}
