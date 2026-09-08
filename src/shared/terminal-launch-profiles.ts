import type { BuiltInWindowsTerminalShell } from './windows-terminal-shell'
import type { StartupCommandDelivery } from './codex-startup-delivery'
import type { TuiAgent } from './tui-agent'
import type { UserTerminalLaunchProfile } from './terminal-launch-profile-definition'

/**
 * The one answer to "what can this workspace launch in a terminal, and which is the default".
 *
 * Shells and agents are modelled by two disjoint unions (`BuiltInWindowsTerminalShell` and
 * `TuiAgent`) that share no launch type, so every surface that wanted to offer both — the tab-bar
 * shell menu, the tab-bar agent list, Settings — re-derived membership on its own. That is fine
 * while there is one menu and fatal once there are several: the terminal toolbar, the application
 * menu and a profile keybinding must offer the same set, or the product lies about what it can do.
 *
 * Shared rather than renderer-owned because the desktop renderer is not the only client of this
 * question. Mobile asks it too, and while it had its own answer a launch profile the user declared
 * existed on one variant and not the other — with nothing failing, because each side's tests only
 * ever asked its own list. A new agent added here now reaches both variants without a second edit.
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
  /**
   * A shell plus the command line that makes it this profile rather than a bare shell.
   *
   * Why a third kind and not a flag on `shell`: a wrapper invocation, a session slot and an `ssh`
   * into a remote script are the same launch to the process table and three different capabilities
   * to the user. Two entries that share an executable but differ in what runs inside it are not one
   * profile — collapsing them is exactly how a "last session" entry becomes a plain new shell.
   *
   * `command` is a command LINE delivered to the shell, which is the shape the spawn path already
   * transports; nothing here needs a wire field that does not exist.
   */
  | {
      readonly kind: 'command'
      readonly id: string
      readonly label: string
      readonly command: string
      /** Non-secret launch configuration. Values may carry workspace tokens. */
      readonly env?: Readonly<Record<string, string>>
      /** Shell family to start first; null or absent means the host's own default. */
      readonly shell?: BuiltInWindowsTerminalShell | null
      readonly startupCommandDelivery?: StartupCommandDelivery
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

/** Namespaced like the others so a user id can never collide with a shell or an agent. */
export function userProfileId(id: string): string {
  return `command:${id}`
}

export function buildTerminalLaunchProfiles({
  shellEntries,
  agentOptions,
  userProfiles,
  defaultAgent,
  hostDefaultShellLabel
}: {
  /** Output of `buildWindowsShellMenuEntries`; undefined when no explicit shell menu applies. */
  shellEntries: readonly { label: string; shell: BuiltInWindowsTerminalShell }[] | undefined
  /** Output of `buildTabAgentLaunchOptions`, already ordered and availability-filtered. */
  agentOptions: readonly { agent: TuiAgent; label: string }[]
  /** Declared by the user and already reviewed; prerequisite filtering happens before this. */
  userProfiles?: readonly UserTerminalLaunchProfile[]
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

  const commandProfiles: TerminalLaunchProfile[] = (userProfiles ?? []).map((profile) => ({
    kind: 'command',
    id: userProfileId(profile.id),
    label: profile.label,
    command: profile.command,
    ...(profile.env ? { env: profile.env } : {}),
    ...(profile.shell ? { shell: profile.shell } : {}),
    ...(profile.startupCommandDelivery
      ? { startupCommandDelivery: profile.startupCommandDelivery }
      : {})
  }))

  // Why agents first: they are the reason this menu is opened. A shell is a fallback the user
  // reaches for deliberately, so the agents belong together at the top where they can be compared
  // — Claude and ChatGPT adjacent, rather than separated by three shells.
  // Why user profiles last: the detected sets answer "what does this machine have", the declared
  // one answers "what did the user add". Ordering the additions after the discoveries keeps the
  // menu stable when a shell or an agent appears or disappears.
  const ordered = [...agentProfiles, ...shellProfiles, ...commandProfiles]
  // 'blank' is the settings value for "a plain terminal, no agent" — a real choice, not an absent
  // one, and it resolves to the shell rather than to the first agent that happens to be installed.
  const preferredAgentId =
    defaultAgent && defaultAgent !== 'blank' ? agentProfileId(defaultAgent) : null
  // Why the shell is named rather than taken as `ordered[0]`: that position used to hold a shell
  // and now holds an agent, so a positional fallback would quietly hand "no agent, please" to
  // whichever agent sorts first. The fallback has to say the word "shell" to keep meaning it.
  const defaultProfileId =
    ordered.find((profile) => profile.id === preferredAgentId)?.id ??
    shellProfiles[0]?.id ??
    ordered[0]?.id ??
    null

  // Why only an agent is hoisted: `orderTabLaunchAgents` already puts the configured agent at the
  // head of the agent list, so this hoist does real work only when the default is a *shell* — and
  // lifting a shell above the agents both contradicts the grouping above and splits the shells in
  // two. The default is still reported through `defaultProfileId`, which is what marks the row.
  const defaultIsAgent = ordered.find((profile) => profile.id === defaultProfileId)?.kind === 'agent'
  return {
    profiles: defaultIsAgent ? hoistDefaultFirst(ordered, defaultProfileId) : ordered,
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
