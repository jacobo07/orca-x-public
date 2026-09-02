import { useAppStore } from '@/store'
import type { TerminalLaunchProfile } from './terminal-launch-profiles'
import {
  resolveCommandProfileStartup,
  type CommandProfileResolution,
  type WorkspaceTokenContext
} from './terminal-launch-profile-resolution'

/**
 * Launches a command profile through the startup queue agents already use.
 *
 * A terminal tab carries a queued startup command into its spawn, and that queue already accepts
 * the command line, the environment and the delivery mode. So a wrapper profile, a session-slot
 * profile and an `ssh`-into-a-remote-script profile all launch through the path that exists rather
 * than a new one built beside it.
 */

export type CommandProfileLaunchResult =
  | { ok: true; tabId: string }
  | Extract<CommandProfileResolution, { ok: false }>

/**
 * The last segment of a path, split on both separators.
 *
 * Both, because the worktree may live on a remote POSIX host while this client runs on Windows —
 * the client's own path module would pick the wrong one. The character class previously held only
 * `/`, which the comment already said was not enough: a local Windows path never split, so the
 * "basename" was the whole path.
 */
function lastPathSegment(path: string): string | null {
  // findLast, not find: a trailing separator leaves an empty last segment, so the basename is the
  // last non-empty one, never the first.
  return path.split(/[\\/]/).findLast(Boolean) ?? null
}

export function resolveWorkspaceTokenContext(worktreeId: string): WorkspaceTokenContext {
  const store = useAppStore.getState()
  const worktree = store.allWorktrees?.().find((entry: { id: string }) => entry.id === worktreeId)
  const path = worktree?.path?.trim() || null
  return {
    workspaceFolder: path,
    workspaceFolderBasename: path ? lastPathSegment(path) : null
  }
}

export function launchCommandTerminalProfile({
  profile,
  worktreeId,
  groupId,
  shellOverride
}: {
  profile: Extract<TerminalLaunchProfile, { kind: 'command' }>
  worktreeId: string
  groupId?: string
  /** Resolved shell executable for the profile's shell family, when it names one. */
  shellOverride?: string
}): CommandProfileLaunchResult {
  const resolution = resolveCommandProfileStartup(profile, resolveWorkspaceTokenContext(worktreeId))
  if (!resolution.ok) {
    return resolution
  }

  const store = useAppStore.getState()
  // Why the shell rides along: a wrapper profile names the shell that must host it (a `/K` batch
  // needs cmd, not pwsh), and recording it on the tab is what keeps the pairing after a restart.
  //
  // Why the profile id as well, when shells and agents get by without it: those two are recoverable
  // from what the tab already stores, and this kind is not. The command is delivered through a
  // startup queue that is consumed once and never persisted, so without the id a restarted wrapper
  // terminal is indistinguishable from a bare shell — which is precisely what it used to become.
  const tab = store.createTab(worktreeId, groupId, shellOverride, {
    launchProfileId: profile.id
  })
  store.queueTabStartupCommand(tab.id, {
    command: resolution.startup.command,
    ...(resolution.startup.env ? { env: resolution.startup.env } : {}),
    ...(resolution.startup.startupCommandDelivery
      ? { startupCommandDelivery: resolution.startup.startupCommandDelivery }
      : {})
  })
  // Why: a worktree showing an editor keeps rendering it, and the new terminal stays hidden.
  store.setActiveTabType('terminal')
  return { ok: true, tabId: tab.id }
}
