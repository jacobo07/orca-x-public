import { useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useLauncherProjectRows } from '@/lib/use-launcher-project-rows'
import { openProjectInWorkbench } from '@/lib/open-project-in-workbench'
import { translate } from '@/i18n/i18n'
import { RecentProjectList } from './recent-project-list'

/**
 * Choosing a project: the filter, the rows, and what opening one means.
 *
 * Shared by both surfaces that stand in for a workspace before one is bound. They used to list the
 * same projects through two different compositions — one that could search and scrolled, one that
 * folded at five rows and could not — so which of them you happened to be looking at decided
 * whether a large estate was navigable. The rows were never the duplicate worth removing; the
 * composition around them was.
 */
export function LauncherProjectPicker(): React.JSX.Element | null {
  const repos = useAppStore((s) => s.repos)
  const [query, setQuery] = useState('')
  // Opening a project the session never named has to ask its host for the workspaces first, which
  // spawns Git. Without a visible pending row that wait is indistinguishable from a dead click.
  const [openingRepoId, setOpeningRepoId] = useState<string | null>(null)
  const filterRef = useRef<HTMLInputElement | null>(null)

  const hasProjects = repos.length > 0
  // The same rows the list renders, so "no project matches" cannot appear above matching rows.
  const matchCount = useLauncherProjectRows(query).length

  const openProject = (repoId: string): void => {
    // Why every surface opens through this and not through the store's worktree activation: only
    // this path resolves a project that has never been opened in this session. Activation needs a
    // workspace already loaded, which on a large estate most rows do not have yet — so the surface
    // that used it disabled the majority of its own rows and called them "still loading".
    setOpeningRepoId(repoId)
    void openProjectInWorkbench(repoId)
      .then((outcome) => {
        if (outcome === 'no-workspace') {
          toast.error(
            translate(
              'auto.components.workspaceLauncher.noWorkspaceToOpen',
              'That project has no workspace to open yet.'
            )
          )
          return
        }
        if (outcome === 'workspace-lookup-failed') {
          toast.error(
            translate(
              'auto.components.workspaceLauncher.couldNotReadWorkspaces',
              'Could not read that project’s workspaces. Check that its folder still exists.'
            )
          )
          return
        }
        if (outcome === 'activation-refused') {
          toast.error(
            translate(
              'auto.components.workspaceLauncher.couldNotOpen',
              'That project could not be opened.'
            )
          )
        }
      })
      // Why cleared unconditionally: opening navigates away, but a refusal leaves the surface on
      // screen, and a row stuck mid-open would be unclickable for the rest of the session.
      .finally(() => setOpeningRepoId(null))
  }

  /**
   * Walks the rows with the arrow keys, so reaching the far end of a large estate does not mean
   * sixty tab stops or the wheel.
   *
   * Home and End are deliberately ignored while the filter has focus: there they mean the ends of
   * the text being typed, and taking them would break editing to add a shortcut.
   */
  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const rows = [
      ...(event.currentTarget.querySelectorAll<HTMLButtonElement>(
        'button[data-launcher-project-row]'
      ) ?? [])
    ]
    if (rows.length === 0) {
      return
    }
    const current = rows.indexOf(document.activeElement as HTMLButtonElement)
    const onRow = current !== -1

    const target = ((): HTMLElement | null => {
      if (event.key === 'ArrowDown') {
        return rows[Math.min(current + 1, rows.length - 1)] ?? null
      }
      if (event.key === 'ArrowUp') {
        // Up from the first row returns to the filter rather than trapping focus in the list.
        return current <= 0 ? filterRef.current : rows[current - 1]
      }
      if (event.key === 'Home' && onRow) {
        return rows[0] ?? null
      }
      if (event.key === 'End' && onRow) {
        return rows.at(-1) ?? null
      }
      return null
    })()

    if (!target) {
      return
    }
    event.preventDefault()
    target.focus()
    // Focusing scrolls the row into view on its own, but only just: `nearest` keeps a row that is
    // already visible where it is instead of jumping the list under the reader.
    target.scrollIntoView({ block: 'nearest' })
  }

  if (!hasProjects) {
    return null
  }

  return (
    // `contents` so this wrapper can carry the key handling without becoming a box in the
    // surrounding column and changing the spacing its callers already lay out.
    <div className="contents" onKeyDown={moveFocus}>
      {/* Why a filter and not just the list: this estate runs to dozens of projects, and past
          roughly a screenful the recents list stops being a shortcut and becomes a scan.
          The magnifier plus the accessible name carry the affordance; hint text inside the
          field would vanish on focus, which is when a filter is actually being read. */}
      <div className="relative mt-4 w-full">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden
        />
        <input
          ref={filterRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={translate(
            'auto.components.workspaceLauncher.filterLabel',
            'Filter projects by name or path'
          )}
          className="h-8 w-full rounded-md border border-border bg-muted/40 pl-8 pr-2.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>

      {/* Both surfaces scroll, so the list shows every match rather than folding at five rows. */}
      <RecentProjectList
        onOpenProject={openProject}
        query={query}
        collapsible={false}
        openingRepoId={openingRepoId}
      />

      {/* Kept distinct from the no-projects case the callers render: "nothing matches what you
          typed" and "you have no projects" ask for different next actions. */}
      {matchCount === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          {translate(
            'auto.components.workspaceLauncher.noMatches',
            'No project matches “{{query}}”.',
            { query }
          )}
        </p>
      ) : null}
    </div>
  )
}
