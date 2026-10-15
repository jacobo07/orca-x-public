import type {
  ReplicaMembership,
  ReplicaMembershipReason,
  ReplicaProvenance,
  ReplicaTopologyEntry
} from '../../../../shared/replica-topology'
import type { ReplicaUnknownReason } from '../../../../shared/workspace-replica-state'
import { translate } from '@/i18n/i18n'

/** Same tones the settings badge already offers; none of them is a status colour. */
export type ReplicaTopologyTone = 'neutral' | 'accent' | 'muted'

export type ReplicaTopologyText = { text: string; tone: ReplicaTopologyTone }

export function describeReplicaProvenance(provenance: ReplicaProvenance): ReplicaTopologyText {
  switch (provenance) {
    case 'imported':
      return {
        text: translate(
          'auto.components.settings.RepositoryPane.provenanceImported',
          'Imported folder'
        ),
        tone: 'muted'
      }
    case 'cloned':
      return {
        text: translate('auto.components.settings.RepositoryPane.provenanceCloned', 'Cloned'),
        tone: 'muted'
      }
    case 'provisioned':
      return {
        text: translate(
          'auto.components.settings.RepositoryPane.provenanceProvisioned',
          'Provisioned'
        ),
        tone: 'muted'
      }
    case 'legacy':
      return {
        text: translate(
          'auto.components.settings.RepositoryPane.provenanceLegacy',
          'Added earlier'
        ),
        tone: 'muted'
      }
    case 'unknown':
      return {
        text: translate(
          'auto.components.settings.RepositoryPane.provenanceUnknown',
          'Origin unknown'
        ),
        tone: 'muted'
      }
  }
}

export function describeReplicaMembership(membership: ReplicaMembership): ReplicaTopologyText {
  switch (membership) {
    case 'sole':
      return {
        text: translate(
          'auto.components.settings.RepositoryPane.membershipSole',
          'Only copy known'
        ),
        tone: 'neutral'
      }
    case 'grouped':
      return {
        text: translate(
          'auto.components.settings.RepositoryPane.membershipGrouped',
          'Grouped with other copies'
        ),
        tone: 'neutral'
      }
    case 'colliding':
      return {
        text: translate(
          'auto.components.settings.RepositoryPane.membershipColliding',
          'Same first commit, possibly a different repository'
        ),
        tone: 'accent'
      }
    case 'identity-pending':
      return {
        text: translate(
          'auto.components.settings.RepositoryPane.membershipPending',
          'Identity not checked yet'
        ),
        tone: 'muted'
      }
    case 'host-local':
      return {
        text: translate(
          'auto.components.settings.RepositoryPane.membershipHostLocal',
          'Not matched across hosts'
        ),
        tone: 'muted'
      }
  }
}

/** Mirrors docs/STYLEGUIDE.md status semantics: synced HEALTHY, stale PRESSURED, conflict CRITICAL, unmeasured UNKNOWN. */
export type ReplicaRelationTone = 'healthy' | 'pressured' | 'critical' | 'unknown'

/** Locale-free relation state of a copy; `unverified` is the only state a missing answer can take. */
export type ReplicaRelationState = NonNullable<ReplicaTopologyEntry['relation']>

export type ReplicaRelationDescription = {
  state: ReplicaRelationState
  text: string
  /** The one closed reason an unverified relation carries, localized; null when none was published. */
  detail: string | null
  tone: ReplicaRelationTone
}

const TONE_BY_RELATION: Record<ReplicaRelationState, ReplicaRelationTone> = {
  same: 'healthy',
  ahead: 'pressured',
  behind: 'pressured',
  diverged: 'critical',
  unrelated: 'critical',
  unverified: 'unknown'
}

const RELATION_KEY = 'auto.components.settings.RepositoryPane'

function relationText(
  state: ReplicaRelationState,
  ahead: number | undefined,
  behind: number | undefined
): string {
  switch (state) {
    case 'same':
      return translate(`${RELATION_KEY}.relationSame`, 'Same commit')
    case 'ahead':
      return ahead === undefined
        ? translate(`${RELATION_KEY}.relationAheadUncounted`, 'Local copy is ahead')
        : translate(`${RELATION_KEY}.relationAhead`, 'Local copy is ahead by {{value0}}', {
            value0: ahead
          })
    case 'behind':
      return behind === undefined
        ? translate(`${RELATION_KEY}.relationBehindUncounted`, 'Local copy is behind')
        : translate(`${RELATION_KEY}.relationBehind`, 'Local copy is behind by {{value0}}', {
            value0: behind
          })
    case 'diverged':
      return ahead === undefined || behind === undefined
        ? translate(`${RELATION_KEY}.relationDivergedUncounted`, 'Diverged from the local copy')
        : translate(
            `${RELATION_KEY}.relationDiverged`,
            'Diverged from the local copy (+{{value0}}/-{{value1}})',
            { value0: ahead, value1: behind }
          )
    case 'unrelated':
      return translate(`${RELATION_KEY}.relationUnrelated`, 'Unrelated histories')
    case 'unverified':
      return translate(`${RELATION_KEY}.relationUnverified`, 'Relation unverified')
  }
}

/** What the pair service published for a copy; a copy with no published relation reads unverified, never same. */
export function describeReplicaRelation(entry: ReplicaTopologyEntry): ReplicaRelationDescription {
  const state = entry.relation ?? 'unverified'
  return {
    state,
    text: relationText(state, entry.relationAhead, entry.relationBehind),
    detail:
      state === 'unverified' && entry.relationUnknownReason
        ? describeReplicaUnknownReason(entry.relationUnknownReason)
        : null,
    tone: TONE_BY_RELATION[state]
  }
}

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

export function describeReplicaMembershipReason(
  reason: ReplicaMembershipReason | undefined
): string | null {
  switch (reason) {
    case undefined:
      return null
    case 'folder':
      return translate(
        'auto.components.settings.RepositoryPane.reasonFolder',
        'Folder workspace: no cross-host identity'
      )
    case 'unborn':
      return translate('auto.components.settings.RepositoryPane.reasonUnborn', 'No commits yet')
    case 'shallow':
      return translate('auto.components.settings.RepositoryPane.reasonShallow', 'Shallow clone')
    case 'malformed':
      return translate(
        'auto.components.settings.RepositoryPane.reasonMalformed',
        'First commit could not be read'
      )
    case 'no-usable-root':
      return translate(
        'auto.components.settings.RepositoryPane.reasonNoUsableRoot',
        'No usable first commit'
      )
    case 'host-not-reporting':
      return translate(
        'auto.components.settings.RepositoryPane.reasonHostNotReporting',
        "Not reported by this host's Orca version"
      )
    case 'same-host-duplicate':
      return translate(
        'auto.components.settings.RepositoryPane.reasonSameHostDuplicate',
        'Another repository on this host shares its first commit'
      )
    case 'shares-root-with-remote-project':
      return translate(
        'auto.components.settings.RepositoryPane.reasonSharesRootWithRemote',
        'Shares its first commit with a project that has a remote'
      )
  }
}

/** Params for the grouping evidence line; the first commit is shown as its short form only. */
export function describeGroupingEvidence(rootCommit: string): string {
  return translate(
    'auto.components.settings.RepositoryPane.groupingEvidence',
    'Grouped by shared first commit {{value0}}. Relation not verified yet',
    { value0: rootCommit.slice(0, 7) }
  )
}
