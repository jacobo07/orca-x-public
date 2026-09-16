import type {
  WorkingSetArtifactOutcome,
  WorkingSetHistory,
  WorkingSetSaveOutcome,
  WorkingSetScopeKey
} from '../../shared/project-working-set-store-types'

/** Sealed project working sets, stored on this desktop only. Saving never touches a terminal. */
export type ProjectWorkingSetApi = {
  workingSet: {
    /** The candidate is revalidated in main; the outcome is 'saved' only after a disk read-back. */
    save: (candidate: unknown) => Promise<WorkingSetSaveOutcome>
    list: (scope: WorkingSetScopeKey) => Promise<WorkingSetHistory>
    read: (args: {
      scope: WorkingSetScopeKey
      workingSetId: string
    }) => Promise<WorkingSetArtifactOutcome>
  }
}
