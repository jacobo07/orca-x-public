import { useMemo, useState } from 'react'
import { FolderPlus, GitBranchPlus, Search } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { filterProjectsByQuery, orderProjectsByRecency } from '@/lib/recent-project-order'
import { openProjectInWorkbench } from '@/lib/open-project-in-workbench'
import { translate } from '@/i18n/i18n'
import { RecentProjectList } from '../recent-project-list'
import logo from '../../../../../resources/logo.svg'

/**
 * The Workspace view's landing surface: open a project, not browse every project.
 *
 * Why this is a different surface from the sidebar's project list rather than a second copy of it:
 * the sidebar answers "which of my projects is this", which is a question about the whole estate,
 * while this answers "which project am I about to work in". Once a project is open, the workspace
 * is the project — so the list that got you there stops being navigation and starts being noise.
 */
export function WorkspaceLauncher(): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const recentProjectIds = useAppStore((s) => s.recentProjectIds)
  const openModal = useAppStore((s) => s.openModal)
  const [query, setQuery] = useState('')
  // Opening a project the session never named has to ask its host for the workspaces first, which
  // spawns Git. Without a visible pending row that wait is indistinguishable from a dead click.
  const [openingRepoId, setOpeningRepoId] = useState<string | null>(null)

  const hasProjects = repos.length > 0
  const matchCount = useMemo(
    () => filterProjectsByQuery(orderProjectsByRecency(repos, recentProjectIds), query).length,
    [repos, recentProjectIds, query]
  )

  const openProject = (repoId: string): void => {
    // The same action the sidebar's project rows use, so "open" means one thing in both places:
    // the workspace last worked in, with a terminal ready. An earlier version of this launcher
    // only switched view, which on a project with no saved session landed on an empty workbench
    // and read as the click doing nothing.
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
      // Why cleared unconditionally: opening navigates away, but a refusal leaves the launcher on
      // screen, and a row stuck mid-open would be unclickable for the rest of the session.
      .finally(() => setOpeningRepoId(null))
  }

  return (
    <div className="absolute inset-0 flex justify-center overflow-y-auto bg-background scrollbar-sleek">
      <div className="w-full max-w-lg px-6 py-12">
        <div className="flex flex-col items-center gap-4">
          <div
            className="flex size-16 items-center justify-center rounded-2xl border border-border/80 shadow-lg shadow-black/40"
            style={{ backgroundColor: '#12181e' }}
          >
            <img
              src={logo}
              alt={translate('auto.components.workspaceLauncher.logoAlt', 'Orca logo')}
              className="size-10"
            />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {translate('auto.components.workspaceLauncher.title', 'Workspace')}
          </h1>
          <p className="text-center text-sm text-muted-foreground">
            {hasProjects
              ? translate(
                  'auto.components.workspaceLauncher.subtitle',
                  'Open a project to start working in it.'
                )
              : translate(
                  'auto.components.workspaceLauncher.subtitleEmpty',
                  'Add a project to get started.'
                )}
          </p>

          <div className="flex flex-wrap items-center justify-center gap-2.5">
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border/80 bg-secondary/70 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              onClick={() => openModal('add-repo')}
            >
              <FolderPlus className="size-3.5" />
              {translate('auto.components.workspaceLauncher.openProject', 'Open project')}
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-secondary/70 px-4 py-2 text-sm font-medium text-foreground transition-colors enabled:cursor-pointer enabled:hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!hasProjects}
              title={
                hasProjects
                  ? undefined
                  : translate(
                      'auto.components.workspaceLauncher.createNeedsProject',
                      'Add a project first'
                    )
              }
              onClick={() => openModal('new-workspace-composer', { telemetrySource: 'unknown' })}
            >
              <GitBranchPlus className="size-3.5" />
              {translate('auto.components.workspaceLauncher.createWorkspace', 'Create workspace')}
            </button>
          </div>

          {/* Why a filter and not just the list: this estate runs to dozens of projects, and past
              roughly a screenful the recents list stops being a shortcut and becomes a scan.
              The magnifier plus the accessible name carry the affordance; hint text inside the
              field would vanish on focus, which is when a filter is actually being read. */}
          {hasProjects ? (
            <div className="relative mt-4 w-full">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                strokeWidth={1.75}
                aria-hidden
              />
              <input
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
          ) : null}

          {/* The launcher scrolls, so it lists every match rather than folding at five rows. */}
          <RecentProjectList
            onOpenProject={openProject}
            query={query}
            collapsible={false}
            openingRepoId={openingRepoId}
          />

          {/* Kept distinct from the no-projects case above: "nothing matches what you typed" and
              "you have no projects" ask for different next actions. */}
          {hasProjects && matchCount === 0 ? (
            <p className="mt-6 text-sm text-muted-foreground">
              {translate(
                'auto.components.workspaceLauncher.noMatches',
                'No project matches “{{query}}”.',
                { query }
              )}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
