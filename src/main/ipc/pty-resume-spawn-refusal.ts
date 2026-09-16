import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../shared/setup-agent-sequencing'

type ResumeSpawnArgs = {
  command?: string
  commandDelivery?: unknown
  startupCommandDelivery?: unknown
  launchConfig?: unknown
  resumeProviderSession?: unknown
  launchToken?: unknown
  launchAgent?: unknown
  telemetry?: unknown
  env?: Record<string, string>
}

/** The same spawn as a plain shell: a refused resume must not launch the provider at all,
 *  because launching it without the session argv would start a different session. */
export function withoutAgentResume<T extends ResumeSpawnArgs>(args: T): T {
  const {
    command: _command,
    commandDelivery: _commandDelivery,
    startupCommandDelivery: _startupCommandDelivery,
    launchConfig: _launchConfig,
    resumeProviderSession: _resumeProviderSession,
    launchToken: _launchToken,
    launchAgent: _launchAgent,
    telemetry: _telemetry,
    env,
    ...rest
  } = args
  if (!env) {
    return rest as T
  }
  const { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: _sequenced, ...plainEnv } = env
  return { ...rest, env: plainEnv } as T
}
