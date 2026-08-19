import { useMemo, useState } from 'react'
import { useAppStore } from '../store'
import { filterProjectsByQuery, orderProjectsByRecency } from '@/lib/recent-project-order'
import { translate } from '@/i18n/i18n'

/** How many rows the launcher shows before "View all" is worth offering. */
const COLLAPSED_ROW_COUNT = 5

/**
 * Keeps the tail of a path, which is the part that identifies the project. A left-truncated
 * "…\Cursor Projects\Vibe Coding Projects" tells you more than a right-truncated "C:\Users\User\Des…".
 */
export function truncatePathFromStart(path: string, maxLength = 46): string {
  return path.length <= maxLength ? path : `…${path.slice(path.length - maxLength + 1)}`
}

/**
 * Most-recently-opened projects, one row each. Shared by the landing screen and the workspace
 * launcher so both stay one list rather than two that drift.
 *
 * `onOpenProject` exists because the two callers mean different things by "open": on the landing
 * screen the workspace view is already showing, so activating the worktree is the whole action,
 * while the launcher is a different view and has to navigate as well.
 */
export function RecentProjectList({
  onOpenProject,
  query = '',
  collapsible = true
}: {
  onOpenProject?: (worktreeId: string) => void
  query?: string
  /** The launcher scrolls its own list instead, so it opts out of the "View all" fold. */
  collapsible?: boolean
} = {}): React.JSX.Element | null {
  const repos = useAppStore((s) => s.repos)
  const recentProjectIds = useAppStore((s) => s.recentProjectIds)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const [expanded, setExpanded] = useState(false)

  const ordered = useMemo(
    () => filterProjectsByQuery(orderProjectsByRecency(repos, recentProjectIds), query),
    [repos, recentProjectIds, query]
  )

  if (ordered.length === 0) {
    return null
  }

  const foldable = collapsible && ordered.length > COLLAPSED_ROW_COUNT
  const rows = foldable && !expanded ? ordered.slice(0, COLLAPSED_ROW_COUNT) : ordered

  return (
    <div className="mt-6 w-full space-y-1">
      <div className="flex items-baseline justify-between px-2">
        <span className="text-xs text-muted-foreground">
          {translate('auto.components.landingRecentProjects.heading', 'Recent projects')}
        </span>
        {foldable ? (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded
              ? translate('auto.components.landingRecentProjects.showFewer', 'Show fewer')
              : translate('auto.components.landingRecentProjects.viewAll', 'View all ({{count}})', {
                  count: ordered.length
                })}
          </button>
        ) : null}
      </div>

      <div className="flex flex-col">
        {rows.map((repo) => {
          // Why disabled rather than hidden: a project whose worktrees have not loaded yet still
          // belongs in the list, and silently dropping it would read as the project being gone.
          const target = worktreesByRepo[repo.id]?.[0] ?? null
          return (
            <button
              key={repo.id}
              type="button"
              disabled={target === null}
              onClick={() => {
                if (!target) {
                  return
                }
                if (onOpenProject) {
                  onOpenProject(target.id)
                  return
                }
                setActiveWorktree(target.id)
              }}
              className="group flex items-baseline justify-between gap-4 rounded-md px-2 py-1 text-left transition-colors enabled:cursor-pointer enabled:hover:bg-accent disabled:opacity-40"
            >
              <span className="shrink-0 text-sm text-foreground">{repo.displayName}</span>
              <span
                className="min-w-0 truncate text-right text-xs text-muted-foreground"
                title={repo.path}
              >
                {truncatePathFromStart(repo.path)}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
