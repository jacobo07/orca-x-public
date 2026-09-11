import { useCallback } from 'react'
import {
  notifyEditorExternalFileChange,
  requestEditorSaveQuiesce
} from '@/components/editor/editor-autosave'
import { getConnectionId } from '@/lib/connection-context'
import {
  bulkDiscardRuntimeGitPaths,
  discardRuntimeGitPath,
  stageRuntimeGitPath,
  unstageRuntimeGitPath,
  type RuntimeGitContext
} from '@/runtime/runtime-git-client'
import { useAppStore } from '@/store'

export function useSourceControlEntryMutations({
  activeRepoSettings,
  activeWorktreeId,
  worktreePath,
  refreshActiveGitStatusAfterMutation
}: {
  activeRepoSettings: RuntimeGitContext['settings']
  activeWorktreeId: string | null
  worktreePath: string | null
  refreshActiveGitStatusAfterMutation: () => Promise<void>
}) {
  const handleStage = useCallback(
    async (filePath: string) => {
      if (!worktreePath) {
        return
      }
      try {
        const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
        await stageRuntimeGitPath(
          {
            // Why: route staging by the repo OWNER host, not the focused runtime.
            settings: activeRepoSettings,
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          filePath
        )
        await refreshActiveGitStatusAfterMutation()
      } catch (error) {
        console.error('[SourceControl] stage failed', error)
      }
    },
    [activeRepoSettings, worktreePath, activeWorktreeId, refreshActiveGitStatusAfterMutation]
  )

  const handleUnstage = useCallback(
    async (filePath: string) => {
      if (!worktreePath) {
        return
      }
      try {
        const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
        await unstageRuntimeGitPath(
          {
            // Why: route unstaging by the repo OWNER host, not the focused runtime.
            settings: activeRepoSettings,
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          filePath
        )
        await refreshActiveGitStatusAfterMutation()
      } catch (error) {
        console.error('[SourceControl] unstage failed', error)
      }
    },
    [activeRepoSettings, worktreePath, activeWorktreeId, refreshActiveGitStatusAfterMutation]
  )

  // Why: discardSingle throws so bulk callers can aggregate failures into one toast; handleDiscard swallows for per-row fire-and-forget.
  // Why the second argument: the caller has to say which working-tree content it is authorizing the
  // destruction of, and the only party that knows is the surface the user acted on. Taking it here
  // rather than reading the file ourselves is the whole point -- a read taken now would describe state
  // the user never saw, which is the race this protects against rather than the protection.
  const discardSingle = useCallback(
    async (filePath: string, expectedContent?: string) => {
      if (!worktreePath || !activeWorktreeId) {
        return
      }
      const runtimeEnvironmentId =
        useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() || null
      // Why: quiesce pending editor autosaves first so a delayed save can't recreate the discarded edits after git restores the file.
      await requestEditorSaveQuiesce({
        worktreeId: activeWorktreeId,
        worktreePath,
        relativePath: filePath,
        runtimeEnvironmentId
      })
      const connectionId = getConnectionId(activeWorktreeId) ?? undefined
      await discardRuntimeGitPath(
        {
          // Why: route the discard by the repo OWNER host, not the focused runtime.
          settings: activeRepoSettings,
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        },
        filePath,
        expectedContent === undefined ? undefined : { expectedContent }
      )
      notifyEditorExternalFileChange({
        worktreeId: activeWorktreeId,
        worktreePath,
        relativePath: filePath,
        runtimeEnvironmentId
      })
    },
    [activeRepoSettings, activeWorktreeId, worktreePath]
  )

  // Why the observed map: the user selected rows they were looking at and authorized destroying THOSE.
  // Per item rather than one token for the whole snapshot, so an unrelated row moving cannot refuse the
  // rest, and so the host can say which single member it kept back.
  const discardMany = useCallback(
    async (filePaths: string[], observed: ReadonlyMap<string, string>) => {
      if (!worktreePath || !activeWorktreeId) {
        return { discarded: [], refused: [] }
      }
      const runtimeEnvironmentId =
        useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() || null
      // Why: quiesce matching editor autosaves first so a delayed save can't recreate edits after git mutates the files.
      await Promise.all(
        filePaths.map((relativePath) =>
          requestEditorSaveQuiesce({
            worktreeId: activeWorktreeId,
            worktreePath,
            relativePath,
            runtimeEnvironmentId
          })
        )
      )
      const connectionId = getConnectionId(activeWorktreeId) ?? undefined
      const outcome = await bulkDiscardRuntimeGitPaths(
        {
          // Why: route the discard by the repo OWNER host, not the focused runtime.
          settings: activeRepoSettings,
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        },
        filePaths,
        observed
      )
      // Only the paths that actually changed on disk. Telling the editor a refused file changed would
      // make it re-read a file nobody touched and imply the discard happened.
      for (const relativePath of outcome.discarded) {
        notifyEditorExternalFileChange({
          worktreeId: activeWorktreeId,
          worktreePath,
          relativePath,
          runtimeEnvironmentId
        })
      }
      return outcome
    },
    [activeRepoSettings, activeWorktreeId, worktreePath]
  )

  return { handleStage, handleUnstage, discardSingle, discardMany }
}
