import { FolderPlus, GitBranchPlus } from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { LauncherProjectPicker } from '../launcher-project-picker'
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
  const openModal = useAppStore((s) => s.openModal)

  const hasProjects = repos.length > 0

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

          <LauncherProjectPicker />
        </div>
      </div>
    </div>
  )
}
