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

export function resolveWorkspaceTokenContext(worktreeId: string): WorkspaceTokenContext {
  const store = useAppStore.getState()
  const worktree = store.allWorktrees?.().find((entry: { id: string }) => entry.id === worktreeId)
  const path = worktree?.path?.trim() || null
  return {
    workspaceFolder: path,
    // Split on both separators: the worktree may live on a remote POSIX host while this client runs
    // on Windows, so the client's own path module would pick the wrong one.
    workspaceFolderBasename: path ? (path.split(/[\/]/).filter(Boolean).pop() ?? null) : null
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
  const tab = store.createTab(worktreeId, groupId, shellOverride)
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
