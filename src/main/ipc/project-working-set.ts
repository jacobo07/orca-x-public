import { ipcMain } from 'electron'
import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type {
  WorkingSetListResult,
  WorkingSetReadResult,
  WorkingSetSaveOutcome,
  WorkingSetScopeKey
} from '../../shared/project-working-set-store-types'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { getDataFile } from '../persistence/loading-store/user-data-path'
import { getProfileTerminalScrollbackSnapshotRoot } from '../terminal-scrollback-snapshots'
import {
  getProfileWorkingSetRoot,
  isCanonicalWorkingSetId
} from '../project-working-set/working-set-store-layout'
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
  const { dataFile } = ensureActiveOrcaProfile()
  const root = getProfileWorkingSetRoot(dataFile)
  // Same roots the session store reads scrollback from, legacy fallback included.
  const snapshotRoot = getProfileTerminalScrollbackSnapshotRoot(dataFile)
  const legacyRoot = getProfileTerminalScrollbackSnapshotRoot(getDataFile())
  const scrollbackStorage = {
    snapshotRoot,
    fallbackSnapshotRoot: legacyRoot === snapshotRoot ? null : legacyRoot
  }

  // Why the candidate is unknown: main re-reads it through the sealed-manifest reader and trusts
  // nothing about the renderer's object beyond what that reader accepts.
  ipcMain.handle(
    'workingSet:save',
    (_event, candidate: unknown): Promise<WorkingSetSaveOutcome> =>
      saveProjectWorkingSet(root, candidate, scrollbackStorage)
  )

  // Why a refusal and not an outcome: a malformed request says nothing about what is stored.
  ipcMain.handle(
    'workingSet:list',
    async (_event, scope: unknown): Promise<WorkingSetListResult> => {
      const key = parseScopeKey(scope)
      return key ? listProjectWorkingSets(root, key) : { status: 'invalid-request', field: 'scope' }
    }
  )

  ipcMain.handle(
    'workingSet:read',
    async (_event, args: unknown): Promise<WorkingSetReadResult> => {
      const { scope, workingSetId } = (args ?? {}) as Record<string, unknown>
      const key = parseScopeKey(scope)
      if (!key) {
        return { status: 'invalid-request', field: 'scope' }
      }
      if (typeof workingSetId !== 'string' || !isCanonicalWorkingSetId(workingSetId)) {
        return { status: 'invalid-request', field: 'workingSetId' }
      }
      return readWorkingSetArtifact(root, key, workingSetId)
    }
  )
}
