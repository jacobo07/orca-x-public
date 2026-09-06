import React from 'react'
import { PER_REPO_FETCH_LIMIT } from '@/lib/new-workspace'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { useAppStore } from '@/store'
import { useRepoMap } from '@/store/selectors'
import { isGitRepoKind } from '../../../shared/repo-kind'
import { getTaskPresetQuery } from '../../../shared/task-preset-query'
import {
  normalizeVisibleTaskProviders,
  restoreAvailableDefaultTaskProvider,
  resolveVisibleTaskProvider
} from '../../../shared/task-providers'
import type { TaskProvider } from '../../../shared/task-providers'

/**
 * Which task providers this profile can actually open, and whether tasks are reachable at all.
 *
 * Extracted from the sidebar row so the activity rail can offer the same provider actions. A
 * provider's availability depends on live host state — glab installed, Linear connected — so it
 * cannot be derived from settings alone, and duplicating that resolution would let the two
 * surfaces disagree about which providers exist.
 */
export type VisibleTaskProviders = {
  /** False when no git repo is attached: tasks exist, but nothing can serve them. */
  canBrowseTasks: boolean
  visibleTaskProviders: TaskProvider[]
  /** Warms the default provider's first page; safe to call on hover and on focus. */
  prefetchTasks: () => void
}

export function useVisibleTaskProviders(): VisibleTaskProviders {
  const repos = useAppStore((s) => s.repos)
  const repoMap = useRepoMap()
  const rawVisibleTaskProviders = useAppStore((s) => s.settings?.visibleTaskProviders)
  const defaultTaskSource = useAppStore((s) => s.settings?.defaultTaskSource ?? 'github')
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const preflightStatusContextKey = useAppStore((s) => s.preflightStatusContextKey)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const expectedPreflightContextKey = useAppStore((s) =>
    localPreflightContextKey(getLocalPreflightContext(s))
  )
  const linearStatus = useAppStore((s) => s.linearStatus)
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)
  const prefetchWorkItems = useAppStore((s) => s.prefetchWorkItems)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const defaultTaskViewPreset = useAppStore((s) => s.settings?.defaultTaskViewPreset ?? 'all')

  const canBrowseTasks = repos.some((repo) => isGitRepoKind(repo))

  const preferredVisibleTaskProviders = React.useMemo(
    () => normalizeVisibleTaskProviders(rawVisibleTaskProviders),
    [rawVisibleTaskProviders]
  )
  const preflightStatusCurrent = preflightStatusContextKey === expectedPreflightContextKey
  const visibleTaskProviders = React.useMemo(
    () =>
      restoreAvailableDefaultTaskProvider(
        preferredVisibleTaskProviders,
        {
          gitlabInstalled: preflightStatusCurrent && preflightStatus?.glab?.installed === true,
          linearConnected: linearStatus.connected === true
        },
        defaultTaskSource
      ),
    [
      defaultTaskSource,
      linearStatus.connected,
      preferredVisibleTaskProviders,
      preflightStatusCurrent,
      preflightStatus?.glab?.installed
    ]
  )
  const resolvedDefaultTaskSource = React.useMemo(
    () => resolveVisibleTaskProvider(defaultTaskSource, visibleTaskProviders),
    [defaultTaskSource, visibleTaskProviders]
  )

  React.useEffect(() => {
    if (!preflightStatusChecked || !preflightStatusCurrent) {
      void refreshPreflightStatus()
    }
    if (!linearStatusChecked) {
      void checkLinearConnection()
    }
  }, [
    checkLinearConnection,
    linearStatusChecked,
    preflightStatusChecked,
    preflightStatusCurrent,
    refreshPreflightStatus
  ])

  const prefetchTasks = React.useCallback(() => {
    if (!canBrowseTasks || resolvedDefaultTaskSource !== 'github') {
      return
    }
    const activeRepo = activeRepoId ? (repoMap.get(activeRepoId) ?? null) : null
    const activeGitRepo = activeRepo && isGitRepoKind(activeRepo) ? activeRepo : null
    const firstGitRepo = activeGitRepo ?? repos.find((r) => isGitRepoKind(r))
    if (firstGitRepo?.path) {
      prefetchWorkItems(
        firstGitRepo.id,
        firstGitRepo.path,
        PER_REPO_FETCH_LIMIT,
        getTaskPresetQuery(defaultTaskViewPreset)
      )
    }
  }, [
    activeRepoId,
    canBrowseTasks,
    defaultTaskViewPreset,
    prefetchWorkItems,
    repoMap,
    repos,
    resolvedDefaultTaskSource
  ])

  return { canBrowseTasks, visibleTaskProviders, prefetchTasks }
}
