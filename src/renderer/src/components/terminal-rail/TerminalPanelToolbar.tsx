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
import { translate } from '@/i18n/i18n'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { useTerminalLaunchProfiles } from '@/hooks/useTerminalLaunchProfiles'
import { launchTerminalProfile } from '@/lib/launch-terminal-profile'
import { describeWithheldTerminalProfile } from '@/lib/terminal-profile-availability-reason'
import { ShellIcon } from '../tab-bar/shell-icons'
import { TerminalProfileIcon } from '../tab-bar/TerminalProfileIcon'

/**
 * The terminal panel's toolbar: new terminal, which kind, the rest, and whether the rail shows.
 *
 * It sits in the group's header strip beside the tab row rather than inside the rail, which is
 * where every mature terminal panel puts it — and it means the controls survive collapsing the
 * rail. A toolbar that disappears with the list it manages cannot bring that list back.
 *
 * The plus creates a terminal on the resolved default immediately — a primary action that opens a
 * menu is not a primary action. The chevron beside it is where choosing something else lives, and
 * every entry in it comes from the canonical profile set, so the menu cannot offer a shell or an
 * agent this host does not have.
 */

const TOOLBAR_BUTTON_CLASS =
  'inline-flex size-[22px] shrink-0 items-center justify-center rounded-[5px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40'

export function TerminalPanelToolbar({
  worktreeId,
  groupId,
  isFocused,
  railCollapsed,
  canActOnTerminal,
  onToggleRail,
  onNewTerminalTab,
  onNewTerminalWithShell,
  onSplitActiveTerminal,
  onCloseActiveTerminal
}: {
  worktreeId: string
  groupId: string
  /** Only the focused group answers the profile-menu command; see the listener below. */
  isFocused: boolean
  railCollapsed: boolean
  canActOnTerminal: boolean
  onToggleRail: () => void
  onNewTerminalTab: () => void
  onNewTerminalWithShell?: (shell: string) => void
  onSplitActiveTerminal: (direction: 'vertical' | 'horizontal') => void
  onCloseActiveTerminal: () => void
}): React.JSX.Element {
  const {
    profiles,
    defaultProfileId,
    withheldUserProfiles,
    defaultWindowsPowerShellImplementation,
    windowsTerminalCapabilities
  } = useTerminalLaunchProfiles({
    worktreeId,
    hasShellLauncher: Boolean(onNewTerminalWithShell)
  })
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
    // Why only when focused: the event is global but every terminal group mounts a toolbar, so an
    // unguarded listener opened one menu per split group for a command the user issued once.
    if (!isFocused) {
      return
    }
    const open = (): void => setProfileMenuOpen(true)
    window.addEventListener(OPEN_TERMINAL_PROFILE_MENU_EVENT, open)
    return () => window.removeEventListener(OPEN_TERMINAL_PROFILE_MENU_EVENT, open)
  }, [isFocused])
  const newTerminalShortcut = useShortcutLabel('tab.newTerminal')
  const splitRightShortcut = useShortcutLabel('terminal.splitRight')
  const splitDownShortcut = useShortcutLabel('terminal.splitDown')

  const newTerminalLabel = translate('auto.components.tab.bar.TabBar.d364f3c8d4', 'New Terminal')
  const toggleRailLabel = translate(
    'auto.components.terminal.rail.TerminalRailToolbar.toggleRail',
    'Toggle terminal rail'
  )

  return (
    <div data-terminal-panel-toolbar="" className="flex shrink-0 items-center gap-px">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-terminal-toolbar-action="new-terminal"
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
            data-terminal-toolbar-action="new-terminal-menu"
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
              <TerminalProfileIcon profile={profile} />
              <span className="flex-1 truncate">{profile.label}</span>
              {profile.id === defaultProfileId ? (
                <span className="text-[10px] text-muted-foreground">
                  {translate('auto.components.terminal.rail.TerminalRailToolbar.default', 'Default')}
                </span>
              ) : null}
            </DropdownMenuItem>
          ))}
          {/* Why show what cannot launch: a profile the user declared and then cannot find reads as
              the product having lost it. Disabled with the reason says which of their machines the
              wrapper is missing from, and tells a pending check apart from a failed one. */}
          {withheldUserProfiles.map((entry) => (
            <DropdownMenuItem
              key={`withheld:${entry.profile.id}`}
              disabled
              className="gap-2 text-[12px] opacity-60"
            >
              <ShellIcon shell={entry.profile.shell ?? undefined} size={14} />
              <span className="flex flex-1 flex-col truncate">
                <span className="truncate">{entry.profile.label}</span>
                <span className="truncate text-[10px] text-muted-foreground">
                  {describeWithheldTerminalProfile(entry)}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-terminal-toolbar-action="more"
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
              {translate(
                'auto.components.tab.bar.SortableTabContextMenu.splitTerminalRight',
                'Split terminal right'
              )}
            </span>
            <span className="text-[10px] text-muted-foreground">{splitRightShortcut}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canActOnTerminal}
            onSelect={() => onSplitActiveTerminal('horizontal')}
            className="gap-2 text-[12px]"
          >
            <span className="flex-1">
              {translate(
                'auto.components.tab.bar.SortableTabContextMenu.splitTerminalDown',
                'Split terminal down'
              )}
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
              {translate(
                'auto.components.terminal.rail.TerminalRailToolbar.closeTerminal',
                'Close terminal'
              )}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-terminal-toolbar-action="collapse"
            aria-label={toggleRailLabel}
            aria-pressed={!railCollapsed}
            onClick={onToggleRail}
            className={TOOLBAR_BUTTON_CLASS}
          >
            {railCollapsed ? (
              <PanelRightOpen className="size-3.5" />
            ) : (
              <PanelRightClose className="size-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{toggleRailLabel}</TooltipContent>
      </Tooltip>
    </div>
  )
}
