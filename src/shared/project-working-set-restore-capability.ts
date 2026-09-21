import type {
  CaptureTimeRestoreCapability,
  WorkingSetEntry,
  WorkingSetPane
} from './project-working-set-types'
import {
  resolveTerminalLaunchProfileIdentity,
  type TerminalLaunchProfileIdentity
} from './terminal-launch-profile-identity'

export type CaptureTimeRestoreClassification = {
  capability: CaptureTimeRestoreCapability
  /** How a non-resumed pane would be relaunched; null when the verdict did not rest on it. */
  launchIdentity: TerminalLaunchProfileIdentity | null
}

/**
 * What the captured evidence alone says a pane can come back as.
 *
 * Not the restore-time verdict — a vanished cwd, host or profile is only knowable then — and never
 * authority to destroy anything: whether a pane may be torn down belongs to the hibernation planner.
 */
export function classifyCaptureTimeRestoreCapability(
  entry: WorkingSetEntry,
  pane: WorkingSetPane
): CaptureTimeRestoreClassification {
  if (pane.resume.kind === 'provider-session') {
    return { capability: 'exact-resume', launchIdentity: null }
  }
  // Why: launch evidence is recorded per tab, and a split's other panes did not run that launch.
  if (entry.panes.length !== 1) {
    return { capability: 'unknown', launchIdentity: null }
  }
  const launchIdentity = resolveTerminalLaunchProfileIdentity({
    launchProfileId: entry.launch.launchProfileId ?? undefined,
    launchAgent: entry.launch.launchAgent ?? undefined,
    shellOverride: entry.launch.shellOverride ?? undefined
  })
  if (launchIdentity.source === 'unknown') {
    return { capability: 'unknown', launchIdentity }
  }
  return { capability: capabilityForProfileId(launchIdentity.profileId), launchIdentity }
}

// Namespaces minted in terminal-launch-profiles.ts; the tests pin them through its own minters.
function capabilityForProfileId(profileId: string): CaptureTimeRestoreCapability {
  if (profileId.startsWith('shell:')) {
    return 'recreate-context'
  }
  // Why: an agent or command profile reruns the recipe; the process and its conversation are new.
  if (profileId.startsWith('agent:') || profileId.startsWith('command:')) {
    return 'restartable'
  }
  return 'unknown'
}
