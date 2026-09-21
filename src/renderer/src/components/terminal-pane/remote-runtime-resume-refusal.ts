import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../../shared/setup-agent-sequencing'

const LAUNCH_FIELDS = [
  'command',
  'startupCommandDelivery',
  'launchConfig',
  'resumeProviderSession',
  'launchToken',
  'launchAgent'
] as const
type LaunchField = (typeof LAUNCH_FIELDS)[number]

/** The plain shell a refused resume opens instead, as the desktop spawn gate does: nothing that
 *  would start the provider again, fresh or resumed. */
export function withoutRuntimeAgentResume<T extends { env?: Record<string, string> }>(
  params: T
): Omit<T, LaunchField> {
  const plain: Record<string, unknown> = { ...params }
  for (const field of LAUNCH_FIELDS) {
    delete plain[field]
  }
  if (params.env) {
    const { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: _sequenced, ...env } = params.env
    plain.env = env
  }
  return plain as Omit<T, LaunchField>
}
