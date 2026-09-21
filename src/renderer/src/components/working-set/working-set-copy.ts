import { translate } from '@/i18n/i18n'
import type { ProductRestoreResult } from '@/lib/project-working-set-product-restore'
import type { RestorePlanBlocker } from '../../../../shared/project-working-set-restore-plan'
import type { WorkingSetReadResult } from '../../../../shared/project-working-set-store-types'
import type { WorkingSetRestoreCapability } from '../../../../shared/project-working-set-types'
import type { WorkingSetHistoryView, WorkingSetProblemKind } from './working-set-history-view'

/** Every sentence the snapshot surface shows; one wording per distinct fact. */

export function historyStateText(view: WorkingSetHistoryView): string | null {
  switch (view.kind) {
    case 'loading':
      return translate('workingSet.history.loading', 'Loading snapshots…')
    case 'unavailable':
      return translate(
        'workingSet.history.unavailable',
        "Snapshots aren't available in this client."
      )
    case 'invalid-request':
      return translate(
        'workingSet.history.invalidRequest',
        "This workspace can't be matched to a snapshot store."
      )
    case 'unreadable':
      return translate(
        'workingSet.history.unreadable',
        "The snapshot store couldn't be read ({{code}}).",
        { code: view.code }
      )
    case 'listed':
      return view.rows.length === 0 && view.problems.length === 0
        ? translate('workingSet.history.empty', 'No snapshots saved for this workspace yet.')
        : null
  }
}

export function problemText(kind: WorkingSetProblemKind): string {
  switch (kind) {
    case 'unsupported-version':
      return translate(
        'workingSet.history.problem.unsupportedVersion',
        'Saved by a newer version of Orca X'
      )
    case 'corrupt':
      return translate('workingSet.history.problem.corrupt', 'Damaged file')
    case 'unreadable':
      return translate('workingSet.history.problem.unreadable', "Couldn't be read")
    case 'missing':
      return translate('workingSet.history.problem.missing', 'No longer on disk')
    case 'unverified':
      return translate('workingSet.history.problem.unverified', "Save wasn't confirmed")
    case 'unrecognized':
      return translate(
        'workingSet.history.problem.unrecognized',
        'Unrecognized file in the snapshot folder'
      )
  }
}

export function capabilityText(capability: WorkingSetRestoreCapability, count: number): string {
  switch (capability) {
    case 'exact-resume':
      return translate('workingSet.history.capability.exactResume', 'Resume session: {{count}}', {
        count
      })
    case 'restartable':
      return translate('workingSet.history.capability.restartable', 'Relaunch: {{count}}', {
        count
      })
    case 'recreate-context':
      return translate(
        'workingSet.history.capability.recreateContext',
        'New terminal in its folder: {{count}}',
        { count }
      )
    case 'history-only':
      return translate('workingSet.history.capability.historyOnly', 'History only: {{count}}', {
        count
      })
    case 'not-restorable':
      return translate(
        'workingSet.history.capability.notRestorable',
        "Can't be restored: {{count}}",
        { count }
      )
    case 'unknown':
      return translate('workingSet.history.capability.unknown', 'Unknown: {{count}}', { count })
  }
}

export function blockerText(blocker: RestorePlanBlocker): string {
  switch (blocker) {
    case 'current-work-present':
      return translate(
        'workingSet.history.blocker.currentWork',
        'This workspace has open tabs. Close them before restoring; nothing is replaced.'
      )
    case 'scope-mismatch':
      return translate(
        'workingSet.history.blocker.scopeMismatch',
        'This snapshot belongs to a different workspace.'
      )
    case 'host-unavailable':
      return translate(
        'workingSet.history.blocker.hostUnavailable',
        "This workspace's host isn't available."
      )
  }
}

export function readProblemText(read: Exclude<WorkingSetReadResult, { status: 'valid' }>): string {
  switch (read.status) {
    case 'missing':
      return translate(
        'workingSet.history.read.missing',
        'This snapshot is no longer on disk. The list has been refreshed.'
      )
    case 'unsupported-version':
      return translate(
        'workingSet.history.read.unsupportedVersion',
        'This snapshot was saved by a newer version of Orca X.'
      )
    case 'corrupt':
      return translate('workingSet.history.read.corrupt', 'This snapshot file is damaged.')
    case 'unreadable':
      return translate(
        'workingSet.history.read.unreadable',
        "This snapshot couldn't be read ({{code}}).",
        {
          code: read.code
        }
      )
    case 'invalid-request':
      return translate(
        'workingSet.history.read.invalidRequest',
        'The request for this snapshot was malformed.'
      )
    case 'unavailable':
      return translate(
        'workingSet.history.unavailable',
        "Snapshots aren't available in this client."
      )
  }
}

/**
 * Null for a restore that succeeded (the surface closes and announces it) and for a click ignored
 * while another restore runs (that one reports).
 */
export function restoreResultText(result: ProductRestoreResult): string | null {
  switch (result.status) {
    case 'restored':
    case 'in-flight':
      return null
    case 'unreadable':
      return readProblemText(result.read)
    case 'refused':
      return result.blockers.map(blockerText).join(' ')
    case 'target-changed':
      return translate(
        'workingSet.history.result.targetChanged',
        'The workspace changed while restoring; nothing was replaced.'
      )
    case 'failed':
      return result.rolledBack
        ? translate(
            'workingSet.history.result.failedRolledBack',
            'Restore failed and was undone; the workspace is unchanged.'
          )
        : translate(
            'workingSet.history.result.failedNotRolledBack',
            "Restore failed and couldn't be fully undone. Check this workspace's tabs."
          )
  }
}

export function restoredToastText(): string {
  return translate(
    'workingSet.history.restored',
    'Snapshot restored. Its tabs start only when you open them.'
  )
}
