import { isPathInsideOrEqual, resolveRuntimePath } from '../../shared/cross-platform-path'

export type AgentSessionResumeStartupCwd =
  | { status: 'workspace-root' }
  | { status: 'resolved'; cwd: string }
  | { status: 'outside-workspace'; requested: string }

/**
 * Where an existing session must be re-entered. A resume claims to continue one exact
 * session, so — unlike opening a new terminal (#7685) — the directory may not be any path
 * the caller names: a remote client could otherwise run an agent anywhere on the host.
 * Nothing requested keeps today's workspace-root launch; outside the workspace is refused
 * rather than quietly rooted, because resuming elsewhere is a different project context.
 */
export function resolveAgentSessionResumeStartupCwd(
  workspacePath: string,
  requestedCwd: string | undefined
): AgentSessionResumeStartupCwd {
  const trimmed = requestedCwd?.trim()
  if (!trimmed) {
    return { status: 'workspace-root' }
  }
  const resolved = resolveRuntimePath(workspacePath, trimmed)
  if (!isPathInsideOrEqual(workspacePath, resolved)) {
    return { status: 'outside-workspace', requested: resolved }
  }
  return { status: 'resolved', cwd: resolved }
}
