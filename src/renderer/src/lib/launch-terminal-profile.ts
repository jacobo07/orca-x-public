import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { launchCommandTerminalProfile } from '@/lib/launch-command-terminal-profile'
import { resolveWindowsShellLaunchTarget } from '@/components/tab-bar/windows-shell-launch'
import {
  findTerminalLaunchProfile,
  type TerminalLaunchProfile
} from '@/lib/terminal-launch-profiles'

/**
 * Turns a chosen profile into the launch the product already knows how to perform.
 *
 * A shell and an agent are genuinely different launches — an agent carries prompt-injection mode,
 * paste quirks and a startup shell that a plain shell has no concept of — so this dispatches to the
 * two existing launchers rather than flattening them into one. The profile set is the only thing
 * unified; how each kind starts stays owned by the code that already got it right.
 */
export function launchTerminalProfile({
  profileId,
  profiles,
  worktreeId,
  groupId,
  powerShellImplementation,
  pwshAvailable,
  onNewTerminalTab,
  onNewTerminalWithShell
}: {
  profileId: string
  profiles: readonly TerminalLaunchProfile[]
  worktreeId: string
  groupId?: string
  powerShellImplementation: 'auto' | 'powershell.exe' | 'pwsh.exe'
  pwshAvailable: boolean
  onNewTerminalTab: () => void
  onNewTerminalWithShell?: (shell: string) => void
}): void {
  const profile = findTerminalLaunchProfile(profiles, profileId)
  if (!profile) {
    // A profile can disappear between opening the menu and choosing from it — an agent detection
    // refresh, a host swap. Falling back to a plain terminal beats doing nothing silently, but the
    // fallback is a different runtime than the one that was chosen, so say so: a substitution the
    // user cannot see is indistinguishable from having picked the wrong entry.
    toast.warning(
      translate(
        'auto.lib.launchTerminalProfile.profileUnavailable',
        'That terminal profile is no longer available. Opened the default terminal instead.'
      )
    )
    onNewTerminalTab()
    return
  }
  if (profile.kind === 'agent') {
    launchAgentInNewTab({
      agent: profile.agent,
      worktreeId,
      groupId,
      launchSource: 'terminal_rail'
    })
    return
  }
  if (profile.kind === 'command') {
    const result = launchCommandTerminalProfile({
      profile,
      worktreeId,
      groupId,
      ...(profile.shell
        ? {
            shellOverride: resolveWindowsShellLaunchTarget(
              profile.shell,
              powerShellImplementation,
              pwshAvailable
            )
          }
        : {})
    })
    if (!result.ok) {
      // Why name the token: a bare "could not launch" sends the user looking at the wrong thing.
      // The profile is fine; this workspace cannot supply one of the values it asks for.
      toast.error(
        translate(
          'auto.lib.launchTerminalProfile.unresolvedToken',
          'This profile needs {{value0}}, which this workspace cannot supply.',
          { value0: result.token }
        )
      )
    }
    return
  }
  if (profile.shell === null || !onNewTerminalWithShell) {
    onNewTerminalTab()
    return
  }
  // Why: the menu models shell families, not executables; preserve a chosen PowerShell 7+ over the
  // inbox powershell.exe, exactly as the tab-bar create menu does.
  onNewTerminalWithShell(
    resolveWindowsShellLaunchTarget(profile.shell, powerShellImplementation, pwshAvailable)
  )
}
