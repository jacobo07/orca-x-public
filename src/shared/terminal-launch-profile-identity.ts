import type { TerminalTab } from './terminal-tab-types'
import type { BuiltInWindowsTerminalShell } from './windows-terminal-shell'
import { WINDOWS_GIT_BASH_SHELL } from './windows-terminal-shell'

/**
 * Answers which launch profile a persisted terminal came from.
 *
 * Tabs created before profiles existed recorded two weaker things: the agent they launched, and the
 * shell executable they resolved to. Both can still answer the question for the cases where the
 * answer is provable, so this reads them rather than migrating them — a derivation re-runs on every
 * load and corrects itself, while a migration writes an inference to disk once and then outlives
 * whatever evidence justified it.
 *
 * `inferred` and `recorded` are kept apart because only one of them is a fact. A recorded id is
 * what the user picked; an inferred id is the best reading of an older tab, and a caller offering
 * to relaunch should be able to tell the difference.
 */

export type TerminalLaunchProfileIdentity =
  | { source: 'recorded'; profileId: string }
  | { source: 'inferred'; profileId: string }
  /** The tab recorded nothing about how it was launched. Not the same as "the default profile". */
  | { source: 'unknown' }

type LaunchIdentityFields = Pick<TerminalTab, 'launchProfileId' | 'launchAgent' | 'shellOverride'>

/**
 * Reverses `resolveWindowsShellLaunchTarget`, which passes every family through untouched except
 * `powershell.exe` — that one becomes whichever implementation the host settled on. So both
 * PowerShell executables map back to the one family, and anything unrecognised maps to nothing.
 */
export function readShellFamilyFromLaunchTarget(
  shellOverride: string | null | undefined
): BuiltInWindowsTerminalShell | null {
  const trimmed = shellOverride?.trim()
  if (!trimmed) {
    return null
  }
  if (trimmed === WINDOWS_GIT_BASH_SHELL) {
    return WINDOWS_GIT_BASH_SHELL
  }
  const basename = trimmed.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? ''
  if (basename === 'powershell.exe' || basename === 'pwsh.exe') {
    return 'powershell.exe'
  }
  if (basename === 'cmd.exe') {
    return 'cmd.exe'
  }
  if (basename === 'wsl.exe') {
    return 'wsl.exe'
  }
  return null
}

export function resolveTerminalLaunchProfileIdentity(
  tab: LaunchIdentityFields
): TerminalLaunchProfileIdentity {
  const recorded = tab.launchProfileId?.trim()
  if (recorded) {
    return { source: 'recorded', profileId: recorded }
  }
  // Why the agent first: it is a one-to-one capability identity that the profile set derives its own
  // ids from, so reading it back is a translation rather than a guess.
  if (tab.launchAgent) {
    return { source: 'inferred', profileId: `agent:${tab.launchAgent}` }
  }
  const family = readShellFamilyFromLaunchTarget(tab.shellOverride)
  if (family) {
    return { source: 'inferred', profileId: `shell:${family}` }
  }
  // Deliberately not the host default: a tab with no shell recorded ran whatever the setting said at
  // the time, and that setting is free to have changed since. Claiming an identity here would put a
  // richer history on the tab than the tab ever had.
  return { source: 'unknown' }
}

export type RecoveredTerminalLaunchProfile<TProfile extends { id: string }> =
  | { status: 'available'; profile: TProfile; source: 'recorded' | 'inferred' }
  /** The tab names a profile this host cannot offer — deleted, or declared on another machine. */
  | { status: 'missing'; profileId: string; source: 'recorded' | 'inferred' }
  | { status: 'unknown' }

/**
 * Pairs a tab's identity with the profiles this host currently offers.
 *
 * A missing profile stays missing. Substituting the default here is what turns "your kClaude
 * terminal is gone" into "here is a terminal", which reads to the user as the profile having
 * silently changed behaviour rather than having been removed.
 */
export function recoverTerminalLaunchProfile<TProfile extends { id: string }>(
  tab: LaunchIdentityFields,
  profiles: readonly TProfile[]
): RecoveredTerminalLaunchProfile<TProfile> {
  const identity = resolveTerminalLaunchProfileIdentity(tab)
  if (identity.source === 'unknown') {
    return { status: 'unknown' }
  }
  const profile = profiles.find((candidate) => candidate.id === identity.profileId)
  return profile
    ? { status: 'available', profile, source: identity.source }
    : { status: 'missing', profileId: identity.profileId, source: identity.source }
}
