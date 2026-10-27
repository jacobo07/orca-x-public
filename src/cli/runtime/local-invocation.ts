import { RuntimeClientError } from './types'

// Why: the SSH relay bridge runs this CLI on the host and reaches the runtime as a local caller, so a
// host-scoped effect (a logon task, a wake target or grant) must be refused here, before any call.
export function assertLocalInvocation(
  env: NodeJS.ProcessEnv,
  command = 'orca serve autostart install/remove'
): void {
  const remoteCwd = env.ORCA_CLI_CWD
  if (typeof remoteCwd === 'string' && remoteCwd.length > 0) {
    throw new RuntimeClientError(
      'remote_invocation_refused',
      `${command} must run in a shell on the Orca host itself, not through a remote SSH session.`
    )
  }
}
