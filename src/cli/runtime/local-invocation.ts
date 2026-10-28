import { RuntimeClientError } from './types'

// Why: the SSH relay bridge runs this CLI on the host and reaches the runtime as a local caller, so a
// host-scoped effect (a logon task, a wake target or grant) must be refused here, before any call.
// Why one message: the WSL bridge also sets ORCA_CLI_CWD, and its wslpath cwd can look like a Windows SSH host's.
export function assertLocalInvocation(
  env: NodeJS.ProcessEnv,
  command = 'orca serve autostart install/remove'
): void {
  const bridgedCwd = env.ORCA_CLI_CWD
  if (typeof bridgedCwd === 'string' && bridgedCwd.length > 0) {
    throw new RuntimeClientError(
      'remote_invocation_refused',
      `${command} must run in a native shell on the Orca host itself, not through a remote or bridged shell (SSH relay or WSL).`
    )
  }
}
