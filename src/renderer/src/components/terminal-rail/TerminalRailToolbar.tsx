import { useEffect, useState } from 'react'
import { ChevronDown, Ellipsis, PanelRightClose, PanelRightOpen, Plus, Trash2 } from 'lucide-react'
import { OPEN_TERMINAL_PROFILE_MENU_EVENT } from '@/constants/terminal'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { useTerminalLaunchProfiles } from '@/hooks/useTerminalLaunchProfiles'
import { launchTerminalProfile } from '@/lib/launch-terminal-profile'
import { AgentIcon } from '@/lib/agent-catalog'
import { ShellIcon } from '../tab-bar/shell-icons'

/**
 * The rail's toolbar, and the reason the rail exists as chrome rather than as a list.
 *
 * The plus creates a terminal on the resolved default immediately — a primary action that opens a
 * menu is not a primary action. The chevron beside it is where choosing something else lives, and
 * every entry in it comes from the canonical profile set, so the menu cannot offer a shell or an
 * agent this host does not have.
 */

const TOOLBAR_BUTTON_CLASS =
  'inline-flex size-[22px] shrink-0 items-center justify-center rounded-[5px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40'

export function TerminalRailToolbar({
  worktreeId,
  groupId,
  collapsed,
  canActOnTerminal,
  onToggleCollapsed,
  onNewTerminalTab,
  onNewTerminalWithShell,
  onSplitActiveTerminal,
  onCloseActiveTerminal
}: {
  worktreeId: string
  groupId: string
  collapsed: boolean
  canActOnTerminal: boolean
  onToggleCollapsed: () => void
  onNewTerminalTab: () => void
  onNewTerminalWithShell?: (shell: string) => void
  onSplitActiveTerminal: (direction: 'vertical' | 'horizontal') => void
  onCloseActiveTerminal: () => void
}): React.JSX.Element {
  const { profiles, defaultProfileId, defaultWindowsPowerShellImplementation, windowsTerminalCapabilities } =
    useTerminalLaunchProfiles({ worktreeId, hasShellLauncher: Boolean(onNewTerminalWithShell) })
  const launchProfile = (profileId: string): void => {
    launchTerminalProfile({
      profileId,
      profiles,
      worktreeId,
      groupId,
      powerShellImplementation: defaultWindowsPowerShellImplementation,
      pwshAvailable: windowsTerminalCapabilities.pwshAvailable,
      onNewTerminalTab,
      onNewTerminalWithShell
    })
  }
  // Why controlled: the profile menu is reachable from a keybinding and the Terminal menu, and a
  // menu only its own trigger can open is not one action with several surfaces.
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  useEffect(() => {
    const open = (): void => setProfileMenuOpen(true)
    window.addEventListener(OPEN_TERMINAL_PROFILE_MENU_EVENT, open)
    return () => window.removeEventListener(OPEN_TERMINAL_PROFILE_MENU_EVENT, open)
  }, [])
  const newTerminalShortcut = useShortcutLabel('tab.newTerminal')
  const splitRightShortcut = useShortcutLabel('terminal.splitRight')
  const splitDownShortcut = useShortcutLabel('terminal.splitDown')
  const closePaneShortcut = useShortcutLabel('terminal.closePane')

  const newTerminalLabel = translate(
    'auto.components.tab.bar.TabBar.d364f3c8d4',
    'New Terminal'
  )

  return (
    <div
      data-terminal-rail-toolbar=""
      className={cn(
        'flex shrink-0 items-center gap-px border-b border-border px-1 py-1',
        collapsed && 'flex-col'
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-terminal-rail-action="new-terminal"
            aria-label={newTerminalLabel}
            onClick={() => {
              if (defaultProfileId) {
                launchProfile(defaultProfileId)
                return
              }
              onNewTerminalTab()
            }}
            className={TOOLBAR_BUTTON_CLASS}
          >
            <Plus className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {newTerminalLabel} {newTerminalShortcut}
        </TooltipContent>
      </Tooltip>

      <DropdownMenu open={profileMenuOpen} onOpenChange={setProfileMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-terminal-rail-action="new-terminal-menu"
            aria-label={translate(
              'auto.components.terminal.rail.TerminalRailToolbar.chooseProfile',
              'Choose terminal profile'
            )}
            className={TOOLBAR_BUTTON_CLASS}
          >
            <ChevronDown className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuLabel className="text-[11px] text-muted-foreground">
            {newTerminalLabel}
          </DropdownMenuLabel>
          {profiles.map((profile) => (
            <DropdownMenuItem
              key={profile.id}
              onSelect={() => launchProfile(profile.id)}
              className="gap-2 text-[12px]"
            >
              {profile.kind === 'agent' ? (
                <AgentIcon agent={profile.agent} size={14} />
              ) : (
                <ShellIcon shell={profile.shell ?? undefined} size={14} />
              )}
              <span className="flex-1 truncate">{profile.label}</span>
              {profile.id === defaultProfileId ? (
                <span className="text-[10px] text-muted-foreground">
                  {translate(
                    'auto.components.terminal.rail.TerminalRailToolbar.default',
                    'Default'
                  )}
                </span>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-terminal-rail-action="more"
            {...(canActOnTerminal
              ? { 'data-contextual-tour-target': 'terminal-pane-split-target' }
              : {})}
            aria-label={translate(
              'auto.components.terminal.rail.TerminalRailToolbar.moreActions',
              'More terminal actions'
            )}
            className={TOOLBAR_BUTTON_CLASS}
          >
            <Ellipsis className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuItem
            disabled={!canActOnTerminal}
            onSelect={() => onSplitActiveTerminal('vertical')}
            className="gap-2 text-[12px]"
          >
            <span className="flex-1">
              {translate('auto.components.tab.bar.SortableTabContextMenu.splitTerminalRight', 'Split terminal right')}
            </span>
            <span className="text-[10px] text-muted-foreground">{splitRightShortcut}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canActOnTerminal}
            onSelect={() => onSplitActiveTerminal('horizontal')}
            className="gap-2 text-[12px]"
          >
            <span className="flex-1">
              {translate('auto.components.tab.bar.SortableTabContextMenu.splitTerminalDown', 'Split terminal down')}
            </span>
            <span className="text-[10px] text-muted-foreground">{splitDownShortcut}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!canActOnTerminal}
            onSelect={onCloseActiveTerminal}
            className="gap-2 text-[12px]"
          >
            <Trash2 className="size-3.5" />
            <span className="flex-1">
              {translate('auto.components.terminal.rail.TerminalRailToolbar.closeTerminal', 'Close terminal')}
            </span>
            <span className="text-[10px] text-muted-foreground">{closePaneShortcut}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className={cn('flex-1', collapsed && 'hidden')} />

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-terminal-rail-action="collapse"
            aria-label={translate(
              'auto.components.terminal.rail.TerminalRailToolbar.toggleRail',
              'Toggle terminal rail'
            )}
            onClick={onToggleCollapsed}
            className={TOOLBAR_BUTTON_CLASS}
          >
            {collapsed ? (
              <PanelRightOpen className="size-3.5" />
            ) : (
              <PanelRightClose className="size-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {translate(
            'auto.components.terminal.rail.TerminalRailToolbar.toggleRail',
            'Toggle terminal rail'
          )}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
