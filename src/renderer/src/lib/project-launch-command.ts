/**
 * The command the project header's launch button runs, and where it runs it.
 *
 * Split from the launcher itself because the decision — is this project launchable, and with what
 * cwd — is the part worth testing; the spawn around it is store plumbing.
 */

/** Command typed into the new terminal once its shell is ready. */
export const PROJECT_LAUNCH_COMMAND = 'kclaude'

export type ProjectLaunchTarget = {
  startupCwd: string
  command: string
}

/**
 * Resolve what to launch for a project, or null when there is nothing safe to launch.
 *
 * Remote projects are refused rather than launched at their raw path: the path belongs to the
 * other host's filesystem, so spawning a local shell there would either fail or, worse, land in a
 * same-named local directory and run the command somewhere the user never chose.
 */
export function resolveProjectLaunchTarget(repo: {
  path?: string | null
  connectionId?: string | null
}): ProjectLaunchTarget | null {
  const path = repo.path?.trim()
  if (!path) {
    return null
  }
  if (repo.connectionId) {
    return null
  }
  return { startupCwd: path, command: PROJECT_LAUNCH_COMMAND }
}
