// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import type { AppState } from '@/store/types'
import { parseWorkspaceSession } from '../../../../shared/workspace-session-schema'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'

const WORKTREE = 'repo-a::/repo-a'
const DIRTY_PATH = '/repo-a/docs/dirty.md'
const CLEAN_PATH = '/repo-a/docs/clean.md'
const DIRTY_DRAFT = 'unsaved line one\né unsaved line two 🚀'
const DISK_SIGNATURE = 'size:42:mtime:1700000000000'

function installWorkspaceState(): void {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeRepoId: 'repo-a',
    activeWorktreeId: WORKTREE,
    settings: { editorAutoSave: false },
    repos: [{ id: 'repo-a', path: '/repo-a', kind: 'git', executionHostId: 'local' }],
    worktreesByRepo: {
      'repo-a': [{ id: WORKTREE, repoId: 'repo-a', path: '/repo-a', hostId: 'local', branch: '' }]
    },
    detectedWorktreesByRepo: {},
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set(),
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    folderWorkspaces: [],
    projectGroups: []
  } as unknown as Partial<AppState>)
}

function openEditFile(filePath: string): string {
  return useAppStore.getState().openFile(
    {
      filePath,
      relativePath: filePath.replace('/repo-a/', ''),
      worktreeId: WORKTREE,
      runtimeEnvironmentId: null,
      language: 'markdown',
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: true }
  )
}

describe('desktop editor hot-exit draft round trip', () => {
  beforeEach(() => {
    installWorkspaceState()
  })

  afterEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
  })

  // Why: the data file is JSON and the main process validates it with this same schema on load, so the persist stage is
  // the serialized bytes read back through the shared parser, not an in-memory handoff.
  function persistAndReadBack(): { bytes: string; session: WorkspaceSessionState } {
    const bytes = JSON.stringify(buildWorkspaceSessionPayload(useAppStore.getState()))
    const parsed = parseWorkspaceSession(JSON.parse(bytes))
    if (!parsed.ok) {
      throw new Error(`persisted session did not validate: ${parsed.error}`)
    }
    return { bytes, session: parsed.value }
  }

  it('an unsaved draft survives capture, persist and hydrate, and its disk baseline is verified before autosave', () => {
    // Arrange: a dirty tab whose draft differs from disk, and a clean tab.
    const dirtyId = openEditFile(DIRTY_PATH)
    const cleanId = openEditFile(CLEAN_PATH)
    useAppStore.getState().setEditorDraft(dirtyId, DIRTY_DRAFT)
    useAppStore.getState().setLastKnownDiskSignature(dirtyId, DISK_SIGNATURE)
    useAppStore.getState().markFileDirty(dirtyId, true)
    useAppStore.getState().setEditorDraft(cleanId, 'a clean tab keeps no draft on disk')

    // Act: capture, serialize and re-validate as the loader does, hydrate a fresh app store.
    const { bytes: onDisk, session: persisted } = persistAndReadBack()
    installWorkspaceState()
    useAppStore.getState().hydrateEditorSession(persisted)

    // Assert: the draft crossed the file boundary byte-for-byte, the clean tab's text did not.
    expect(onDisk).toContain('dirtyDraftContent')
    expect(onDisk).not.toContain('a clean tab keeps no draft on disk')
    const state = useAppStore.getState()
    const restoredDirty = state.openFiles.find((f) => f.filePath === DIRTY_PATH)
    const restoredClean = state.openFiles.find((f) => f.filePath === CLEAN_PATH)
    expect(restoredDirty).toMatchObject({
      isDirty: true,
      lastKnownDiskSignature: DISK_SIGNATURE,
      pendingDiskBaselineVerification: true
    })
    expect(state.editorDrafts[restoredDirty!.id]).toBe(DIRTY_DRAFT)
    expect(restoredClean).toMatchObject({ isDirty: false })
    expect(state.editorDrafts[restoredClean!.id]).toBeUndefined()
  })

  it('an emptied buffer is a draft too: the empty string survives the round trip as dirty', () => {
    // Arrange: the user deleted every character; "" must not read as "no draft".
    const id = openEditFile(DIRTY_PATH)
    useAppStore.getState().setEditorDraft(id, '')
    useAppStore.getState().markFileDirty(id, true)

    // Act
    const { session: persisted } = persistAndReadBack()
    installWorkspaceState()
    useAppStore.getState().hydrateEditorSession(persisted)

    // Assert
    const restored = useAppStore.getState().openFiles.find((f) => f.filePath === DIRTY_PATH)
    expect(restored).toMatchObject({ isDirty: true })
    expect(useAppStore.getState().editorDrafts[restored!.id]).toBe('')
  })

  it('a read-only tab never comes back dirty even when a draft is planted in the persisted session', () => {
    // Arrange: a persisted session carrying a draft on a read-only tab.
    const id = openEditFile(DIRTY_PATH)
    useAppStore.getState().setEditorDraft(id, DIRTY_DRAFT)
    useAppStore.getState().markFileDirty(id, true)
    const { session: persisted } = persistAndReadBack()
    const planted: WorkspaceSessionState = {
      ...persisted,
      openFilesByWorktree: Object.fromEntries(
        Object.entries(persisted.openFilesByWorktree ?? {}).map(([key, files]) => [
          key,
          files.map((file) => ({ ...file, readOnly: true }))
        ])
      )
    }

    // Act
    installWorkspaceState()
    useAppStore.getState().hydrateEditorSession(planted)

    // Assert
    const restored = useAppStore.getState().openFiles.find((f) => f.filePath === DIRTY_PATH)
    expect(restored).toMatchObject({ readOnly: true, isDirty: false })
    expect(useAppStore.getState().editorDrafts[restored!.id]).toBeUndefined()
  })
})
