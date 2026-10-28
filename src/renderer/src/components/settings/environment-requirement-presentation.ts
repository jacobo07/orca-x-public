import { translate } from '@/i18n/i18n'
import type { PrepareRefusalReasonCode } from '../../../../shared/environment-prepare-run-result'
import type { RequirementState } from '../../../../shared/environment-requirement-state'

// The surface maps a tone to classes; the presenter owns which tone a state has.
export type EnvironmentRequirementTone = 'success' | 'attention' | 'danger' | 'neutral'

const KEY = 'auto.components.settings.EnvironmentRequirementPresentation'

type StatePresentation = { tone: EnvironmentRequirementTone; label: string }

// Why: unknown and unsupported are neutral on purpose; only a measured satisfied state is success.
export function presentRequirementState(state: RequirementState): StatePresentation {
  switch (state) {
    case 'satisfied':
      return { tone: 'success', label: translate(`${KEY}.stateSatisfied`, 'Satisfied') }
    case 'missing':
      return { tone: 'danger', label: translate(`${KEY}.stateMissing`, 'Missing') }
    case 'incompatible':
      return { tone: 'danger', label: translate(`${KEY}.stateIncompatible`, 'Incompatible') }
    case 'needs-authorization':
      return {
        tone: 'attention',
        label: translate(`${KEY}.stateNeedsAuthorization`, 'Needs your action')
      }
    case 'unsupported':
      return {
        tone: 'neutral',
        label: translate(`${KEY}.stateUnsupported`, 'Does not apply here')
      }
    case 'unknown':
      return { tone: 'neutral', label: translate(`${KEY}.stateUnknown`, 'Unknown') }
  }
}

// Reason codes come from the classifier and the host's probes; each maps to words, and a code this
// Orca does not describe says so instead of printing the code.
export function presentRequirementReason(reason: string): string {
  switch (reason) {
    case 'found':
      return translate(`${KEY}.reasonFound`, 'Found on this host')
    case 'version-in-range':
      return translate(`${KEY}.reasonVersionInRange`, 'Version is in the required range')
    case 'version-out-of-range':
      return translate(`${KEY}.reasonVersionOutOfRange`, 'Version is outside the required range')
    case 'signed-in':
      return translate(`${KEY}.reasonSignedIn`, 'Signed in')
    case 'sign-in-required':
      return translate(`${KEY}.reasonSignInRequired`, 'Sign-in is required')
    case 'agent-detected':
      return translate(`${KEY}.reasonAgentDetected`, 'Agent detected')
    case 'agent-not-detected':
      return translate(`${KEY}.reasonAgentNotDetected`, 'Agent not detected')
    case 'env-present':
      return translate(`${KEY}.reasonEnvPresent`, 'Environment variable is set')
    case 'env-unset':
      return translate(`${KEY}.reasonEnvUnset`, 'Environment variable is not set')
    case 'platform-matches':
      return translate(`${KEY}.reasonPlatformMatches`, 'Platform matches')
    case 'platform-skipped':
      return translate(`${KEY}.reasonPlatformSkipped`, "Does not apply to this host's platform")
    case 'platform-unmeasured':
      return translate(
        `${KEY}.reasonPlatformUnmeasured`,
        "The host's platform could not be measured"
      )
    case 'command-absent':
      return translate(`${KEY}.reasonCommandAbsent`, 'Command not found')
    case 'credential-cli-absent':
      return translate(`${KEY}.reasonCredentialCliAbsent`, 'Credential tool not found')
    case 'prepare-unapproved':
      return translate(
        `${KEY}.reasonPrepareUnapproved`,
        'A setup step is declared and has not been approved on this host'
      )
    case 'unsupported-version-range':
      return translate(
        `${KEY}.reasonUnsupportedVersionRange`,
        'This version range is not supported by this Orca'
      )
    case 'version-missing':
      return translate(`${KEY}.reasonVersionMissing`, 'The version could not be read')
    case 'kind-not-evaluated':
      return translate(
        `${KEY}.reasonKindNotEvaluated`,
        'This Orca does not evaluate this kind of requirement'
      )
    case 'malformed-requirement':
      return translate(`${KEY}.reasonMalformed`, 'This requirement is malformed')
    case 'probe-missing':
      return translate(`${KEY}.reasonProbeMissing`, 'No measurement came back for this requirement')
    case 'probe-refused':
      return translate(`${KEY}.reasonProbeRefused`, 'The host refused to measure this')
    case 'probe-failed':
      return translate(`${KEY}.reasonProbeFailed`, 'The measurement failed')
    case 'unreachable':
      return translate(`${KEY}.reasonUnreachable`, 'Host unreachable')
    case 'host-predates-probes':
      return translate(`${KEY}.reasonHostPredatesProbes`, "This host's Orca is too old to measure")
    case 'refused':
      return translate(`${KEY}.reasonRefused`, 'The host refused to measure')
    case 'timed-out':
      return translate(`${KEY}.reasonTimedOut`, 'The measurement timed out')
    case 'contract-unreadable':
      return translate(
        `${KEY}.reasonContractUnreadable`,
        'orca.yaml could not be read on this host'
      )
    case 'contract-unparseable':
      return translate(
        `${KEY}.reasonContractUnparseable`,
        'orca.yaml could not be parsed on this host'
      )
    default:
      return translate(
        `${KEY}.reasonNotDescribed`,
        'The host gave a reason this Orca does not describe'
      )
  }
}

export function presentPrepareRefusal(reason: PrepareRefusalReasonCode): string {
  switch (reason) {
    case 'contract-unreadable':
      return translate(
        `${KEY}.refusalContractUnreadable`,
        'orca.yaml could not be read on that host'
      )
    case 'requirement-not-declared':
      return translate(
        `${KEY}.refusalNotDeclared`,
        "That host's orca.yaml no longer declares this step"
      )
    case 'approval-for-another-host':
      return translate(
        `${KEY}.refusalAnotherHost`,
        'The approval was recorded for a different host'
      )
    case 'contract-changed':
      return translate(
        `${KEY}.refusalContractChanged`,
        'orca.yaml changed after you approved it. Review it and approve again.'
      )
    case 'approval-unreadable':
      return translate(
        `${KEY}.refusalApprovalUnreadable`,
        'Orca could not read the recorded approval'
      )
    case 'approval-missing':
      return translate(
        `${KEY}.refusalApprovalMissing`,
        'No approval is recorded for this exact step'
      )
    case 'host-identity-unverified':
      return translate(
        `${KEY}.refusalIdentityUnverified`,
        "That host's identity could not be verified"
      )
    case 'already-satisfied':
      return translate(`${KEY}.refusalAlreadySatisfied`, 'This requirement is already satisfied')
    case 'requirement-not-applicable':
      return translate(
        `${KEY}.refusalNotApplicable`,
        'This requirement does not apply to that host'
      )
    case 'host-predates-prepare':
      return translate(
        `${KEY}.refusalHostPredates`,
        "That host's Orca is too old to run setup steps"
      )
    case 'unreachable':
      return translate(`${KEY}.refusalUnreachable`, 'That host could not be reached')
    case 'host-refused-unknown':
    default:
      return translate(
        `${KEY}.refusalNotDescribed`,
        'The host refused for a reason this Orca does not describe'
      )
  }
}
