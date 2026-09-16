import type {
  WorkingSetListResult,
  WorkingSetReadResult,
  WorkingSetRestoreEvidenceResult,
  WorkingSetSaveResult,
  WorkingSetScopeKey
} from '../../shared/project-working-set-store-types'

type WorkingSetRef = { scope: WorkingSetScopeKey; workingSetId: string }

/**
 * Sealed project working sets, stored on this desktop only. Saving never touches a terminal.
 * A client without a store answers 'unavailable'; the desktop never does.
 */
export type ProjectWorkingSetApi = {
  workingSet: {
    /** The candidate is revalidated in main; the outcome is 'saved' only after a disk read-back. */
    save: (candidate: unknown) => Promise<WorkingSetSaveResult>
    list: (scope: WorkingSetScopeKey) => Promise<WorkingSetListResult>
    read: (args: WorkingSetRef) => Promise<WorkingSetReadResult>
    /** Filesystem and provider facts a restore depends on, for a working set main reads itself. */
    probeRestoreEvidence: (args: WorkingSetRef) => Promise<WorkingSetRestoreEvidenceResult>
  }
}
