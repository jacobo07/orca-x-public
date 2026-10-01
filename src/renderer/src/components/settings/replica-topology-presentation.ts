import type {
  ReplicaMembership,
  ReplicaMembershipReason,
  ReplicaProvenance
} from '../../../../shared/replica-topology'
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

/** The relation word of a grouped copy; it is a word, never an icon. */
export function describeReplicaRelation(): string {
  return translate(
    'auto.components.settings.RepositoryPane.relationUnverified',
    'Relation unverified'
  )
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
