import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { WorkingSetSaveOutcome } from '../../../shared/project-working-set-store-types'
import type { ProjectWorkingSetManifest } from '../../../shared/project-working-set-types'
import {
  projectWorkingSetFromState,
  type WorkingSetCaptureResult
} from './project-working-set-capture'

export type WorkingSetSaveDeps = {
  readState: () => AppState
  save: (manifest: ProjectWorkingSetManifest) => Promise<WorkingSetSaveOutcome | undefined>
  now: () => number
  newId: () => string
}

export type WorkingSetSaveRequestResult =
  | Extract<WorkingSetCaptureResult, { status: 'not-capturable' }>
  /** This client has no sealed store (the browser client); nothing was attempted. */
  | { status: 'store-unavailable' }
  | WorkingSetSaveOutcome

const defaultDeps: WorkingSetSaveDeps = {
  readState: () => useAppStore.getState(),
  // The web client's fallback proxy resolves this to undefined.
  save: (manifest) => window.api.workingSet.save(manifest),
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
  const outcome = await deps.save(captured.manifest)
  return typeof outcome === 'object' && outcome !== null ? outcome : { status: 'store-unavailable' }
}
