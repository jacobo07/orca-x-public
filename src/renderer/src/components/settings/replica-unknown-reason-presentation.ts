import type { ReplicaUnknownReason } from '../../../../shared/workspace-replica-state'
import { translate } from '@/i18n/i18n'

const RELATION_KEY = 'auto.components.settings.RepositoryPane'

/** One localized sentence per closed reason; the exhaustive switch makes a 16th reason a compile error. */
export function describeReplicaUnknownReason(reason: ReplicaUnknownReason): string {
  switch (reason) {
    case 'host-unreachable':
      return translate(`${RELATION_KEY}.relationReasonHostUnreachable`, 'Host not reachable')
    case 'tip-unknown':
      return translate(
        `${RELATION_KEY}.relationReasonTipUnknown`,
        'Could not read the current commit'
      )
    case 'unborn':
      return translate(`${RELATION_KEY}.relationReasonUnborn`, 'No commits yet')
    case 'relay-too-old':
      return translate(
        `${RELATION_KEY}.relationReasonRelayTooOld`,
        'Remote Orca helper is too old to compare'
      )
    case 'transport-unsupported-host':
      return translate(
        `${RELATION_KEY}.relationReasonTransportUnsupportedHost`,
        'Comparison is not supported for this kind of host'
      )
    case 'no-comparison-site':
      return translate(
        `${RELATION_KEY}.relationReasonNoComparisonSite`,
        'No local copy to compare against'
      )
    case 'bundle-too-large':
      return translate(
        `${RELATION_KEY}.relationReasonBundleTooLarge`,
        'Changes too large to compare'
      )
    case 'bundle-verify-failed':
      return translate(
        `${RELATION_KEY}.relationReasonBundleVerifyFailed`,
        'Comparison data failed verification'
      )
    case 'bundle-heads-mismatch':
      return translate(
        `${RELATION_KEY}.relationReasonBundleHeadsMismatch`,
        'Comparison data did not match the copy'
      )
    case 'transfer-interrupted':
      return translate(
        `${RELATION_KEY}.relationReasonTransferInterrupted`,
        'Comparison was interrupted'
      )
    case 'shallow':
      return translate(
        `${RELATION_KEY}.relationReasonShallow`,
        'Shallow clone: history is incomplete'
      )
    case 'evidence-stale':
      return translate(
        `${RELATION_KEY}.relationReasonEvidenceStale`,
        'The copy changed since it was compared'
      )
    case 'not-compared':
      return translate(`${RELATION_KEY}.relationReasonNotCompared`, 'Not compared yet')
    case 'not-a-git-repo':
      return translate(
        `${RELATION_KEY}.relationReasonNotAGitRepo`,
        'Folder workspace: not a Git repository'
      )
    case 'worktree-not-verified-clean':
      return translate(
        `${RELATION_KEY}.relationReasonWorktreeNotVerifiedClean`,
        'Same commit, but the working tree is not verified clean'
      )
  }
}
