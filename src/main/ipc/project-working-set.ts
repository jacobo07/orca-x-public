import { ipcMain } from 'electron'
import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type {
  WorkingSetArtifactOutcome,
  WorkingSetHistory,
  WorkingSetSaveOutcome,
  WorkingSetScopeKey
} from '../../shared/project-working-set-store-types'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { getProfileWorkingSetRoot } from '../project-working-set/working-set-store-layout'
import {
  listProjectWorkingSets,
  readWorkingSetArtifact,
  saveProjectWorkingSet
} from '../project-working-set/working-set-store'

function parseScopeKey(value: unknown): WorkingSetScopeKey | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { executionHostId, ownerKey } = value as Record<string, unknown>
  if (typeof executionHostId !== 'string' || typeof ownerKey !== 'string' || !ownerKey) {
    return null
  }
  return parseExecutionHostId(executionHostId)
    ? { executionHostId: executionHostId as ExecutionHostId, ownerKey }
    : null
}

export function registerProjectWorkingSetHandlers(): void {
  // Why resolved once: the Store is bound to the profile active at startup, and a profile switch
  // relaunches; resolving per call could file a save under a profile this process is not serving.
  const root = getProfileWorkingSetRoot(ensureActiveOrcaProfile().dataFile)

  // Why the candidate is unknown: main re-reads it through the sealed-manifest reader and trusts
  // nothing about the renderer's object beyond what that reader accepts.
  ipcMain.handle(
    'workingSet:save',
    (_event, candidate: unknown): Promise<WorkingSetSaveOutcome> =>
      saveProjectWorkingSet(root, candidate)
  )

  ipcMain.handle('workingSet:list', (_event, scope: unknown): Promise<WorkingSetHistory> => {
    const key = parseScopeKey(scope)
    return key
      ? listProjectWorkingSets(root, key)
      : Promise.resolve({ status: 'unreadable', code: 'EINVAL' })
  })

  ipcMain.handle('workingSet:read', (_event, args: unknown): Promise<WorkingSetArtifactOutcome> => {
    const { scope, workingSetId } = (args ?? {}) as Record<string, unknown>
    const key = parseScopeKey(scope)
    return key && typeof workingSetId === 'string'
      ? readWorkingSetArtifact(root, key, workingSetId)
      : Promise.resolve({ status: 'missing' })
  })
}
