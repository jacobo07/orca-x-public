import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { WorkingSetSaveResult } from '../../../shared/project-working-set-store-types'
import type { ProjectWorkingSetManifest } from '../../../shared/project-working-set-types'
import {
  projectWorkingSetFromState,
  type WorkingSetCaptureResult
} from './project-working-set-capture'
import { saveWorkingSetManifest } from './project-working-set-client'

export type WorkingSetSaveDeps = {
  readState: () => AppState
  save: (manifest: ProjectWorkingSetManifest) => Promise<WorkingSetSaveResult>
  now: () => number
  newId: () => string
}

export type WorkingSetSaveRequestResult =
  | Extract<WorkingSetCaptureResult, { status: 'not-capturable' }>
  | WorkingSetSaveResult

const defaultDeps: WorkingSetSaveDeps = {
  readState: () => useAppStore.getState(),
  save: (manifest) => saveWorkingSetManifest(manifest),
  now: () => Date.now(),
  newId: () => crypto.randomUUID()
}

/**
 * Captures one workspace's rail and hands it to main. The state is read once and projected before
 * the first await, so a store change while the save is in flight cannot leak into the manifest.
 * Non-destructive: no terminal, PTY or agent is touched.
 */
export async function saveProjectWorkingSet(
  request: { ownerKey: string; label?: string | null },
  deps: WorkingSetSaveDeps = defaultDeps
): Promise<WorkingSetSaveRequestResult> {
  const state = deps.readState()
  const captured = projectWorkingSetFromState(state, {
    ownerKey: request.ownerKey,
    label: request.label ?? null,
    workingSetId: deps.newId(),
    createdAt: deps.now()
  })
  if (captured.status !== 'captured') {
    return captured
  }
  return deps.save(captured.manifest)
}
