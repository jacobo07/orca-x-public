import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { getConnectionId } from '@/lib/connection-context'
import { bulkUnstageRuntimeGitPaths, type RuntimeGitContext } from '@/runtime/runtime-git-client'
import { translate } from '@/i18n/i18n'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import {
  getDiscardAllEntries,
  runDiscardAllForArea,
  type DiscardAllArea
} from './discard-all-sequence'
import { discardRefusalMessage } from './discard-refusal-message'
import type { PendingDiscardConfirmation } from './discard-dialog'
import type { SourceControlEntryGroups } from '../listing/section-order'

export function useSourceControlDiscardConfirmation({
  activeRepoSettings,
  activeWorktreeId,
  worktreePath,
  grouped,
  isExecutingBulk,
  setIsExecutingBulk,
  clearSelection,
  discardMany,
  discardSingle,
  refreshActiveGitStatusAfterMutation
}: {
  activeRepoSettings: RuntimeGitContext['settings']
  activeWorktreeId: string | null
  worktreePath: string | null
  grouped: SourceControlEntryGroups
  isExecutingBulk: boolean
  setIsExecutingBulk: (value: boolean) => void
  clearSelection: () => void
  discardMany: (
    paths: string[],
    observed: ReadonlyMap<string, string>
  ) => Promise<{ discarded: string[]; refused: string[] }>
  /** The second argument is the working-tree content the caller observed; omitting it means it could
   *  not say, never that nothing changed. */
  discardSingle: (path: string, expectedContent?: string) => Promise<void>
  refreshActiveGitStatusAfterMutation: () => Promise<void>
}) {
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscardConfirmation | null>(null)
  // Why: reset during render so a worktree switch never paints the previous confirmation.
  const [pendingDiscardWorktreeId, setPendingDiscardWorktreeId] = useState(activeWorktreeId)
  if (pendingDiscardWorktreeId !== activeWorktreeId) {
    setPendingDiscardWorktreeId(activeWorktreeId)
    setPendingDiscard(null)
  }

  // Why the entry rather than its path: the pending confirmation already holds the whole row, and the
  // row is the only record of what the user actually looked at. Passing the path alone -- which is what
  // this did -- discarded that record one frame before the destruction, so the host was asked to remove
  // whatever happened to be at the path by then. A dialog waiting on a human is the longest of the
  // windows between the two, and an external editor or formatter needs none of Orca's own machinery to
  // land inside it.
  const handleDiscard = useCallback(
    async (entry: GitStatusEntry) => {
      try {
        await discardSingle(entry.path, entry.worktreeContentId)
        await refreshActiveGitStatusAfterMutation()
      } catch (error) {
        // Why not silent: this used to be fire-and-forget because every failure was a genuine error.
        // A refusal is not a failure -- it means the file moved and the user's newer work was kept --
        // and saying nothing would read as a successful discard of work that is still there.
        const message = discardRefusalMessage(error)
        if (message) {
          toast.message(message)
        }
      }
    },
    [discardSingle, refreshActiveGitStatusAfterMutation]
  )

  // Why: "Discard all" skips unresolved/resolved_locally rows (discarding can re-create the conflict or lose the resolution; no v1 UX for it).
  // Why: sequencing/filter rules live in discard-all-sequence.ts for independent unit tests, with per-file fallback when an older SSH relay lacks bulk discard.
  const handleRevertAllInArea = useCallback(
    async (area: DiscardAllArea, confirmedEntries?: readonly GitStatusEntry[]) => {
      if (!worktreePath || !activeWorktreeId || isExecutingBulk) {
        return
      }
      const entries = confirmedEntries
        ? [...confirmedEntries]
        : getDiscardAllEntries(grouped[area], area)
      if (entries.length === 0) {
        return
      }
      const paths = entries.map((entry) => entry.path)
      // The rows the user was looking at, keyed for the host. Built here rather than resolved further
      // down, because every layer below this one deals in paths and a path cannot say what it held.
      const observed = new Map(
        entries
          .filter((entry) => typeof entry.worktreeContentId === 'string')
          .map((entry) => [entry.path, entry.worktreeContentId as string])
      )
      setIsExecutingBulk(true)
      try {
        const connectionId = getConnectionId(activeWorktreeId) ?? undefined
        // Why: onError fires per failure; aggregate into one toast so a partial failure across N files doesn't spam N toasts.
        const errors: unknown[] = []
        const result = await runDiscardAllForArea(area, paths, {
          bulkUnstage: (filePaths) =>
            bulkUnstageRuntimeGitPaths(
              {
                // Why: route unstaging by the repo OWNER host, not the focused runtime.
                settings: activeRepoSettings,
                worktreeId: activeWorktreeId,
                worktreePath,
                connectionId
              },
              filePaths
            ),
          discardMany: (filePaths) => discardMany(filePaths, observed),
          discardOne: (filePath) => discardSingle(filePath, observed.get(filePath)),
          onError: (error) => {
            errors.push(error)
            console.error('[SourceControl] discard-all failure', error)
          }
        })
        if (result.aborted) {
          toast.error(
            translate(
              'auto.components.right.sidebar.SourceControl.a5e5a11090',
              'Discard all failed — unable to unstage files before discard'
            ),
            { description: errors[0] instanceof Error ? errors[0].message : undefined }
          )
        } else if (result.failed.length > 0) {
          // Why: show only the first error + a sample of failed paths to avoid a huge toast body on bulk failures.
          const firstMsg = errors[0] instanceof Error ? errors[0].message : undefined
          const sample = result.failed.slice(0, 3).join(', ')
          const more = result.failed.length > 3 ? `, +${result.failed.length - 3} more` : ''
          toast.error(
            translate(
              'auto.components.right.sidebar.SourceControl.8eb3782a0c',
              'Failed to discard {{value0}} file{{value1}}',
              { value0: result.failed.length, value1: result.failed.length === 1 ? '' : 's' }
            ),
            {
              description: firstMsg
                ? translate(
                    'auto.components.right.sidebar.SourceControl.dc5a6465fc',
                    '{{value0}} (e.g. {{value1}}{{value2}})',
                    { value0: firstMsg, value1: sample, value2: more }
                  )
                : `${sample}${more}`
            }
          )
        }
        if (result.refused.length > 0) {
          // Its own notice, not folded into the failure toast above. These files moved after the user
          // looked at them and nothing was destroyed, so the newer work is still there -- reporting that
          // as a failure would send someone hunting for a fault, and reporting nothing at all would let
          // the survivors read as a bug in the discard. A count and a sample; never a hash.
          const sample = result.refused.slice(0, 3).join(', ')
          const more = result.refused.length > 3 ? `, +${result.refused.length - 3} more` : ''
          toast.message(
            translate(
              'auto.components.right.sidebar.SourceControl.discardRefusedCount',
              'Kept {{value0}} file{{value1}} that changed after you opened them',
              { value0: result.refused.length, value1: result.refused.length === 1 ? '' : 's' }
            ),
            { description: `${sample}${more}` }
          )
        }
        if (!result.aborted) {
          await refreshActiveGitStatusAfterMutation()
          clearSelection()
        }
      } finally {
        setIsExecutingBulk(false)
      }
    },
    [
      activeRepoSettings,
      worktreePath,
      activeWorktreeId,
      grouped,
      isExecutingBulk,
      clearSelection,
      discardMany,
      discardSingle,
      refreshActiveGitStatusAfterMutation,
      setIsExecutingBulk
    ]
  )

  const requestDiscardAllInArea = useCallback(
    (area: DiscardAllArea, confirmedEntries?: readonly GitStatusEntry[]): void => {
      if (!worktreePath || !activeWorktreeId || isExecutingBulk) {
        return
      }
      const entries = confirmedEntries
        ? [...confirmedEntries]
        : getDiscardAllEntries(grouped[area], area)
      if (entries.length === 0) {
        return
      }
      setPendingDiscard({ kind: 'area', area, entries })
    },
    [activeWorktreeId, grouped, isExecutingBulk, worktreePath]
  )
  const requestDiscardEntry = useCallback(
    (entry: GitStatusEntry): void => {
      if (!worktreePath || !activeWorktreeId || isExecutingBulk) {
        return
      }
      setPendingDiscard({ kind: 'entry', entry })
    },
    [activeWorktreeId, isExecutingBulk, worktreePath]
  )
  const requestDiscardEntries = useCallback(
    (area: DiscardAllArea, entries: readonly GitStatusEntry[]): void => {
      // Why: same gate as the other request handlers — handleRevertAllInArea rejects these states silently, so the dialog would confirm into a no-op.
      if (!worktreePath || !activeWorktreeId || isExecutingBulk || entries.length === 0) {
        return
      }
      setPendingDiscard({ kind: 'area', area, entries: [...entries] })
    },
    [activeWorktreeId, isExecutingBulk, worktreePath]
  )
  const cancelPendingDiscard = useCallback(() => setPendingDiscard(null), [])
  const confirmPendingDiscard = useCallback((): void => {
    const pending = pendingDiscard
    if (!pending) {
      return
    }
    setPendingDiscard(null)
    if (pending.kind === 'entry') {
      void handleDiscard(pending.entry)
      return
    }
    void handleRevertAllInArea(pending.area, pending.entries)
  }, [handleDiscard, handleRevertAllInArea, pendingDiscard])

  return {
    pendingDiscard,
    requestDiscardAllInArea,
    requestDiscardEntry,
    requestDiscardEntries,
    cancelPendingDiscard,
    confirmPendingDiscard
  }
}
