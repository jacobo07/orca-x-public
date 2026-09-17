import { useEffect, useState } from 'react'
import { previewWorkingSetRestore } from '@/lib/project-working-set-restore'
import type { TerminalLaunchProfileReadiness } from '@/lib/terminal-launch-profile-readiness'
import type { WorkingSetRestorePlan } from '../../../../shared/project-working-set-restore-plan'
import type {
  WorkingSetReadResult,
  WorkingSetScopeKey
} from '../../../../shared/project-working-set-store-types'

export type WorkingSetPreview =
  | { kind: 'idle' }
  | { kind: 'waiting-for-profiles' }
  | { kind: 'loading' }
  | { kind: 'unreadable'; read: Exclude<WorkingSetReadResult, { status: 'valid' }> }
  | { kind: 'planned'; plan: WorkingSetRestorePlan }

/** The profiles a restore may be judged against right now; undefined means "not yet". */
export function launchProfilesForRestore(
  readiness: TerminalLaunchProfileReadiness,
  profiles: readonly { id: string }[]
): readonly { id: string }[] | null | undefined {
  if (readiness === 'resolving') {
    return undefined
  }
  // Why null and not the partial set: a set a probe could not complete is not proof of absence.
  return readiness === 'resolved' ? profiles : null
}

/**
 * What restoring the selected snapshot would do, via the same planner the restore uses. Advisory:
 * the restore re-checks the workspace at the moment it applies.
 */
export function useWorkingSetPreview(
  scope: WorkingSetScopeKey,
  workingSetId: string | null,
  launchProfiles: readonly { id: string }[] | null | undefined,
  revision: number
): WorkingSetPreview {
  const [preview, setPreview] = useState<WorkingSetPreview>({ kind: 'idle' })
  const { executionHostId, ownerKey } = scope
  const waitingForProfiles = launchProfiles === undefined

  useEffect(() => {
    if (workingSetId === null) {
      setPreview({ kind: 'idle' })
      return
    }
    if (launchProfiles === undefined) {
      setPreview({ kind: 'waiting-for-profiles' })
      return
    }
    let cancelled = false
    setPreview({ kind: 'loading' })
    void previewWorkingSetRestore({
      scope: { executionHostId, ownerKey },
      workingSetId,
      launchProfiles
    }).then((outcome) => {
      if (cancelled) {
        return
      }
      setPreview(
        outcome.status === 'planned'
          ? { kind: 'planned', plan: outcome.plan }
          : { kind: 'unreadable', read: outcome.read }
      )
    })
    return () => {
      cancelled = true
    }
  }, [executionHostId, launchProfiles, ownerKey, revision, waitingForProfiles, workingSetId])

  return preview
}
