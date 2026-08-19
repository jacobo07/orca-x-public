import { useMemo } from 'react'
import { House } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { resolveActiveProjectIdentity } from '../lib/active-project-identity'
import { useAppStore } from '../store'

/**
 * The project half of the titlebar: which project this workbench is showing, and the way back to
 * Home.
 *
 * Home navigates rather than closing anything. The terminal workbench stays mounted once it has
 * mounted, so the panes, PTYs and scrollback of the project are still there on return — going Home
 * is a change of view, not an exit from the work.
 */
export function WorkspaceProjectChrome(): React.JSX.Element | null {
  // Why selected apart and memoised: a selector building this object would return a new reference
  // on every store update, re-rendering the titlebar on unrelated state such as terminal output.
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const repos = useAppStore((s) => s.repos)
  const openWorkspacePage = useAppStore((s) => s.openWorkspacePage)
  const project = useMemo(
    () => resolveActiveProjectIdentity({ activeRepoId, activeWorktreeId, repos }),
    [activeRepoId, activeWorktreeId, repos]
  )

  if (!project) {
    return null
  }

  return (
    <div className="flex items-center gap-1.5 min-w-0 pl-2">
      <span
        className="text-xs text-muted-foreground truncate max-w-[16rem]"
        title={project.displayName}
      >
        {project.displayName}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className="titlebar-icon-button"
            onClick={openWorkspacePage}
            aria-label={translate('auto.WorkspaceProjectChrome.home', 'Go to Workspace home')}
          >
            <House size={14} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate('auto.WorkspaceProjectChrome.home', 'Go to Workspace home')}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
