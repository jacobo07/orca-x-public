import { useAppStore } from '@/store'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { requestFloatingTerminalOpen } from '@/lib/floating-terminal'
import { resolveProjectLaunchTarget } from '@/lib/project-launch-command'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

export type ProjectLaunchOutcome = 'launched' | 'unsupported-project' | 'workspace-disabled'

/**
 * Open the workspace panel and start the project's launch command in a fresh terminal rooted at
 * the project's own folder.
 *
 * The panel is used rather than a workspace because a project need not have one: creating a
 * workspace to run a command would touch git in every repo that has none, which is a far larger
 * side effect than the user asked for by pressing play.
 *
 * The command is queued rather than written directly — the PTY layer sends it once the shell is
 * ready, so it cannot be swallowed by a shell that has not finished starting.
 */
export function launchProjectInWorkspacePanel(repo: {
  path?: string | null
  connectionId?: string | null
}): ProjectLaunchOutcome {
  const target = resolveProjectLaunchTarget(repo)
  if (!target) {
    return 'unsupported-project'
  }
  const store = useAppStore.getState()
  // Reported rather than silently ignored: with the panel disabled the tab would be created into a
  // surface that never renders, which reads to the user as the button doing nothing.
  if (store.settings?.floatingTerminalEnabled !== true) {
    return 'workspace-disabled'
  }

  requestFloatingTerminalOpen()

  const tab = store.createTab(
    FLOATING_TERMINAL_WORKTREE_ID,
    store.activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? undefined,
    undefined,
    {
      activate: false,
      startupCwd: target.startupCwd,
      quickCommandLabel: target.command
    }
  )
  store.queueTabStartupCommand(tab.id, { command: target.command })
  store.activateTab(tab.id)
  focusTerminalTabSurface(tab.id)
  return 'launched'
}
