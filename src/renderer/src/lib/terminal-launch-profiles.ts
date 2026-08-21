import type { BuiltInWindowsTerminalShell } from '../../../shared/windows-terminal-shell'
import type { TuiAgent } from '../../../shared/tui-agent'

/**
 * The one answer to "what can this workspace launch in a terminal, and which is the default".
 *
 * Shells and agents are modelled by two disjoint unions (`BuiltInWindowsTerminalShell` and
 * `TuiAgent`) that share no launch type, so every surface that wanted to offer both — the tab-bar
 * shell menu, the tab-bar agent list, Settings — re-derived membership on its own. That is fine
 * while there is one menu and fatal once there are several: the terminal toolbar, the application
 * menu and a profile keybinding must offer the same set, or the product lies about what it can do.
 *
 * This module does not decide availability. Both inputs arrive already filtered by the code that
 * can actually know — detected agents, probed Git Bash / WSL — and nothing here invents an entry
 * those builders did not produce. A profile in this list is a profile that launches.
 */

export type TerminalLaunchProfile =
  | {
      readonly kind: 'shell'
      readonly id: string
      readonly label: string
      /** null means the host's own default shell, which is all a POSIX host offers. */
      readonly shell: BuiltInWindowsTerminalShell | null
    }
  | {
      readonly kind: 'agent'
      readonly id: string
      readonly label: string
      readonly agent: TuiAgent
    }

export type TerminalLaunchProfileSet = {
  readonly profiles: readonly TerminalLaunchProfile[]
  /** Always an id present in `profiles`; null only when there is nothing to launch. */
  readonly defaultProfileId: string | null
}

/** Identifies the host's own shell, the entry that exists when no explicit shell menu applies. */
export const HOST_DEFAULT_SHELL_PROFILE_ID = 'shell:default'

// Why namespaced ids: the two unions are independent, so a shell name and an agent id can collide —
// `cursor` is a real TuiAgent and a plausible shell label. One flat id space needs a discriminator.
function shellProfileId(shell: BuiltInWindowsTerminalShell): string {
  return `shell:${shell}`
}

export function agentProfileId(agent: TuiAgent): string {
  return `agent:${agent}`
}

export function buildTerminalLaunchProfiles({
  shellEntries,
  agentOptions,
  defaultAgent,
  hostDefaultShellLabel
}: {
  /** Output of `buildWindowsShellMenuEntries`; undefined when no explicit shell menu applies. */
  shellEntries: readonly { label: string; shell: BuiltInWindowsTerminalShell }[] | undefined
  /** Output of `buildTabAgentLaunchOptions`, already ordered and availability-filtered. */
  agentOptions: readonly { agent: TuiAgent; label: string }[]
  defaultAgent: TuiAgent | 'blank' | null | undefined
  hostDefaultShellLabel: string
}): TerminalLaunchProfileSet {
  const shellProfiles: TerminalLaunchProfile[] =
    shellEntries && shellEntries.length > 0
      ? shellEntries.map((entry) => ({
          kind: 'shell',
          id: shellProfileId(entry.shell),
          label: entry.label,
          shell: entry.shell
        }))
      : [
          {
            kind: 'shell',
            id: HOST_DEFAULT_SHELL_PROFILE_ID,
            label: hostDefaultShellLabel,
            shell: null
          }
        ]

  const agentProfiles: TerminalLaunchProfile[] = agentOptions.map((option) => ({
    kind: 'agent',
    id: agentProfileId(option.agent),
    label: option.label,
    agent: option.agent
  }))

  const ordered = [...shellProfiles, ...agentProfiles]
  // 'blank' is the settings value for "a plain terminal, no agent" — a real choice, not an absent
  // one, and it resolves to the shell rather than to the first agent that happens to be installed.
  const preferredAgentId =
    defaultAgent && defaultAgent !== 'blank' ? agentProfileId(defaultAgent) : null
  const defaultProfileId =
    ordered.find((profile) => profile.id === preferredAgentId)?.id ?? ordered[0]?.id ?? null

  return {
    profiles: hoistDefaultFirst(ordered, defaultProfileId),
    defaultProfileId
  }
}

function hoistDefaultFirst(
  profiles: readonly TerminalLaunchProfile[],
  defaultProfileId: string | null
): readonly TerminalLaunchProfile[] {
  if (!defaultProfileId) {
    return profiles
  }
  const found = profiles.find((profile) => profile.id === defaultProfileId)
  if (!found) {
    return profiles
  }
  return [found, ...profiles.filter((profile) => profile.id !== defaultProfileId)]
}

export function findTerminalLaunchProfile(
  profiles: readonly TerminalLaunchProfile[],
  profileId: string | null | undefined
): TerminalLaunchProfile | null {
  if (!profileId) {
    return null
  }
  return profiles.find((profile) => profile.id === profileId) ?? null
}
