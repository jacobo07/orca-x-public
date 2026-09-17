import type { UserTerminalProfileAvailability } from '@/hooks/useAvailableUserTerminalProfiles'

/**
 * Whether a launch-profile set is the host's full answer yet.
 *
 * Why it matters: the set is built from three asynchronous probes, and a set built before they
 * finish omits profiles that exist. Anything that judges "is this profile gone?" against a partial
 * set reports a real profile as missing, which reads as proof rather than as "still asking".
 *
 * - resolving: at least one probe has not answered; wait.
 * - resolved: every probe answered; the set is authoritative for this host.
 * - unresolvable: a probe could not be asked; the set is not proof of absence.
 */
export type TerminalLaunchProfileReadiness = 'resolving' | 'resolved' | 'unresolvable'

export type TerminalLaunchProfileReadinessInputs = {
  windowsProbe: {
    enabled: boolean
    /** True once this owner has any published answer, success or failure. */
    answered: boolean
    isLoading: boolean
    /** Null in a published answer means the probe failed. */
    hostPlatform: NodeJS.Platform | null
  }
  agentDetection: {
    detectedIds: readonly string[] | null
    isLoading: boolean
    detectionFailed: boolean
  }
  userProfiles: readonly Pick<UserTerminalProfileAvailability, 'state'>[]
}

export function resolveTerminalLaunchProfileReadiness(
  inputs: TerminalLaunchProfileReadinessInputs
): TerminalLaunchProfileReadiness {
  const { windowsProbe, agentDetection, userProfiles } = inputs
  const windowsPending = windowsProbe.enabled && (windowsProbe.isLoading || !windowsProbe.answered)
  const agentsPending =
    !agentDetection.detectionFailed &&
    (agentDetection.isLoading || agentDetection.detectedIds === null)
  const profilesPending = userProfiles.some((entry) => entry.state === 'probing')
  if (windowsPending || agentsPending || profilesPending) {
    return 'resolving'
  }
  const windowsFailed = windowsProbe.enabled && windowsProbe.hostPlatform === null
  const profilesFailed = userProfiles.some((entry) => entry.state === 'probe-unavailable')
  if (windowsFailed || agentDetection.detectionFailed || profilesFailed) {
    return 'unresolvable'
  }
  return 'resolved'
}
