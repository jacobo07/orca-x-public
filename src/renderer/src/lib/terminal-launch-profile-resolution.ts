import type { StartupCommandDelivery } from '../../../shared/codex-startup-delivery'
import type { TerminalLaunchProfile } from './terminal-launch-profiles'

/**
 * Turns a command profile into the startup a terminal tab already knows how to queue.
 *
 * The whole point is that it resolves HERE, in the client, into fields the launch path already
 * carries end to end. Sending a profile identity instead would mean a host that predates the
 * profile receives something it does not understand and quietly launches a different runtime —
 * and a substitution the user cannot see is worse than a profile that says it is unavailable.
 */

export type WorkspaceTokenContext = {
  /** Absolute path of the worktree this terminal opens in, when one is known. */
  workspaceFolder: string | null
  /** Its last path segment — what a remote helper script is usually handed. */
  workspaceFolderBasename: string | null
}

export type ResolvedCommandStartup = {
  command: string
  env?: Record<string, string>
  startupCommandDelivery?: StartupCommandDelivery
}

export type CommandProfileResolution =
  | { ok: true; startup: ResolvedCommandStartup }
  /** The command names something this workspace cannot supply; launching it would be a lie. */
  | { ok: false; reason: 'unresolved-token'; token: string }

const TOKEN_PATTERN = /\$\{([A-Za-z][A-Za-z0-9]*)\}/g

function expand(
  value: string,
  context: WorkspaceTokenContext
): { ok: true; value: string } | { ok: false; token: string } {
  let failedToken: string | null = null
  const expanded = value.replace(TOKEN_PATTERN, (_match, token: string) => {
    const resolved =
      token === 'workspaceFolder'
        ? context.workspaceFolder
        : token === 'workspaceFolderBasename'
          ? context.workspaceFolderBasename
          : null
    if (resolved === null || resolved === '') {
      // Why record rather than throw: the first failure is the one worth naming, and a
      // half-substituted string must never reach a shell.
      failedToken ??= token
      return _match
    }
    return resolved
  })
  return failedToken === null ? { ok: true, value: expanded } : { ok: false, token: failedToken }
}

export function resolveCommandProfileStartup(
  profile: Extract<TerminalLaunchProfile, { kind: 'command' }>,
  context: WorkspaceTokenContext
): CommandProfileResolution {
  const command = expand(profile.command, context)
  if (!command.ok) {
    return { ok: false, reason: 'unresolved-token', token: command.token }
  }

  const startup: ResolvedCommandStartup = { command: command.value }

  if (profile.env) {
    const env: Record<string, string> = {}
    for (const [key, rawValue] of Object.entries(profile.env)) {
      const expanded = expand(rawValue, context)
      if (!expanded.ok) {
        return { ok: false, reason: 'unresolved-token', token: expanded.token }
      }
      env[key] = expanded.value
    }
    startup.env = env
  }

  if (profile.startupCommandDelivery) {
    startup.startupCommandDelivery = profile.startupCommandDelivery
  }

  return { ok: true, startup }
}
