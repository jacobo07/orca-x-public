import { useMemo } from 'react'

import { useAppStore } from '@/store'
import { useLiveDashboardSnapshot } from '../dashboard/useLiveDashboardSnapshot'
import { useSidebarHostScopeOptions } from '../sidebar/use-sidebar-host-scope-options'

import {
  indexHostReachability,
  projectRunningSessions,
  type WorkspaceRunningSession
} from './workspace-running-sessions'

/** Running terminal agents from the live dashboard snapshot — the same one the agent board reads. */
export function useWorkspaceRunningSessions(): readonly WorkspaceRunningSession[] {
  const snapshot = useLiveDashboardSnapshot()
  const setups = useAppStore((s) => s.projectHostSetups)
  const { hostOptions } = useSidebarHostScopeOptions()
  return useMemo(() => {
    const projectIdByRepoId = new Map(setups.map((setup) => [setup.repoId, setup.projectId]))
    return projectRunningSessions(
      snapshot.cards,
      indexHostReachability(hostOptions),
      projectIdByRepoId
    )
  }, [snapshot.cards, setups, hostOptions])
}
