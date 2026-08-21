import { useEffect } from 'react'
import { useAppStore } from '../../store'
import { OPEN_TERMINAL_PROFILE_MENU_EVENT } from '@/constants/terminal'
import { requestActiveTerminalPaneSplit } from '@/components/tab-bar/request-active-terminal-pane-split'
import type { TerminalMenuCommand } from '../../../../shared/terminal-menu-command'

/**
 * Routes the application menu's Terminal items into the actions the renderer already performs.
 *
 * Deliberately no logic of its own: a menu that reimplemented split or new-terminal would be a
 * second definition of both, which is how a toolbar and a menu drift into doing different things.
 * Each case here forwards to the same entry point the keybinding and the rail use.
 */
export function useTerminalMenuCommands(): void {
  useEffect(() => {
    const run = (command: TerminalMenuCommand): void => {
      const state = useAppStore.getState()
      const worktreeId = state.activeWorktreeId
      const groupId = worktreeId ? state.activeGroupIdByWorktree[worktreeId] : undefined
      switch (command) {
        case 'newTerminal':
          void state.openNewTerminalTabInActiveWorkspace(groupId)
          return
        case 'chooseProfile':
          window.dispatchEvent(new CustomEvent(OPEN_TERMINAL_PROFILE_MENU_EVENT))
          return
        case 'splitRight':
        case 'splitDown': {
          // Why the active tab rather than a remembered one: the menu acts on what the user is
          // looking at, and a stale tab id would split a terminal off screen.
          const tabId = state.activeTabType === 'terminal' ? state.activeTabId : null
          if (!tabId) {
            return
          }
          requestActiveTerminalPaneSplit({
            tabId,
            direction: command === 'splitRight' ? 'vertical' : 'horizontal'
          })
          return
        }
        case 'toggleRail':
          state.toggleTerminalRailCollapsed()
      }
    }
    return window.api.ui.onTerminalCommand(run)
  }, [])
}
