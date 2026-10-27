import { classifyCaptureTimeRestoreCapability } from './project-working-set-restore-capability'
import { provenExactResume } from './proven-exact-resume'
import type {
  WorkingSetFactPresence,
  WorkingSetRestoreEvidence
} from './project-working-set-store-types'
import type {
  CaptureTimeRestoreCapability,
  WorkingSetEntry,
  WorkingSetPane,
  WorkingSetRestoreCapability
} from './project-working-set-types'
import { recoverTerminalLaunchProfile } from './terminal-launch-profile-identity'

/**
 * What a sealed pane can come back as TODAY.
 *
 * Capture-time capability is evidence, not authority: a positive verdict needs today's world to
 * confirm it, and a negative one needs today's world to prove it. Anything in between stays
 * unknown and keeps the captured verdict beside it, so a later attempt can still be offered
 * without being promised.
 */

export type RestoreTimeReason =
  /** The probe could not run at all (no store, or the working set could not be read). */
  | 'evidence-unavailable'
  | 'location-missing'
  | 'location-unconfirmed'
  /** A recorded transcript was proven deleted. */
  | 'provider-session-gone'
  | 'resume-unconfirmed'
  | 'launch-profile-missing'
  | 'launch-profile-unconfirmed'
  | 'launch-unknown'
  /** Recreatable, but not in the directory it was launched from. */
  | 'startup-cwd-missing'

export type RestoreTimeClassification = {
  capability: WorkingSetRestoreCapability
  captured: CaptureTimeRestoreCapability
  /** Whether this working set holds its own copy of the pane's history. */
  history: WorkingSetFactPresence
  reasons: RestoreTimeReason[]
}

export type RestoreTimeInputs = {
  /** Null when main could not be asked. */
  evidence: WorkingSetRestoreEvidence | null
  /** Profiles this host offers now; null when not known. */
  launchProfiles: readonly { id: string }[] | null
}

type Relaunch = Extract<WorkingSetRestoreCapability, 'restartable' | 'recreate-context'>

function relaunchVerdict(
  entry: WorkingSetEntry,
  capability: CaptureTimeRestoreCapability,
  inputs: RestoreTimeInputs,
  reasons: RestoreTimeReason[]
): Relaunch | 'unknown' | 'proven-impossible' {
  if (capability !== 'restartable' && capability !== 'recreate-context') {
    reasons.push('launch-unknown')
    return 'unknown'
  }
  if (!inputs.launchProfiles) {
    reasons.push('launch-profile-unconfirmed')
    return 'unknown'
  }
  const recovered = recoverTerminalLaunchProfile(
    {
      launchProfileId: entry.launch.launchProfileId ?? undefined,
      launchAgent: entry.launch.launchAgent ?? undefined,
      shellOverride: entry.launch.shellOverride ?? undefined
    },
    inputs.launchProfiles
  )
  if (recovered.status === 'missing') {
    reasons.push('launch-profile-missing')
    return 'proven-impossible'
  }
  if (recovered.status === 'unknown') {
    reasons.push('launch-unknown')
    return 'unknown'
  }
  return capability
}

export function classifyRestoreTimeCapability(
  entry: WorkingSetEntry,
  pane: WorkingSetPane,
  inputs: RestoreTimeInputs
): RestoreTimeClassification {
  const captured = classifyCaptureTimeRestoreCapability(entry, pane).capability
  const facts = inputs.evidence?.panes[`${entry.tabId}:${pane.leafId}`] ?? null
  const history = facts?.sealedScrollback ?? 'unknown'
  const location = inputs.evidence?.location ?? 'unknown'
  const reasons: RestoreTimeReason[] = inputs.evidence ? [] : ['evidence-unavailable']
  const verdict = (capability: WorkingSetRestoreCapability): RestoreTimeClassification => ({
    capability,
    captured,
    history,
    reasons
  })
  // Proven that nothing can run; only the sealed history can still be shown.
  const provenUnrunnable = () => verdict(history === 'present' ? 'history-only' : 'not-restorable')

  if (location === 'absent') {
    reasons.push('location-missing')
    return provenUnrunnable()
  }

  let relaunchFrom: CaptureTimeRestoreCapability = captured
  if (captured === 'exact-resume') {
    const transcript = facts?.transcript ?? 'unknown'
    if (transcript !== 'absent') {
      if (provenExactResume(transcript, location)) {
        return verdict('exact-resume')
      }
      reasons.push(location === 'present' ? 'resume-unconfirmed' : 'location-unconfirmed')
      return verdict('unknown')
    }
    reasons.push('provider-session-gone')
    // Why the tab's launch evidence: with the conversation gone, rerunning its recipe is what is left.
    relaunchFrom = classifyCaptureTimeRestoreCapability(entry, {
      ...pane,
      resume: { kind: 'absent', reason: 'no-provider-session-captured' }
    }).capability
  }

  const relaunch = relaunchVerdict(entry, relaunchFrom, inputs, reasons)
  if (relaunch === 'proven-impossible') {
    return provenUnrunnable()
  }
  if (relaunch === 'unknown') {
    // A gone conversation with no known way to rerun it leaves only history, when there is some.
    return captured === 'exact-resume' && history === 'present'
      ? verdict('history-only')
      : verdict('unknown')
  }
  if (location !== 'present') {
    reasons.push('location-unconfirmed')
    return verdict('unknown')
  }
  if (entry.startupCwd !== null && inputs.evidence?.startupCwdByTabId[entry.tabId] === 'absent') {
    reasons.push('startup-cwd-missing')
  }
  return verdict(relaunch)
}
