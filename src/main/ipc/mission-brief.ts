import { ipcMain } from 'electron'
import type { MissionBriefResult } from '../../shared/mission-brief-types'
import type { Store } from '../persistence'
import { createGsdRunner, gsdToolsAvailable } from '../mission-brief/gsd-tools-runner'
import {
  fileExists,
  listDirs,
  planningFingerprint,
  readGitHead
} from '../mission-brief/mission-brief-host-io'
import { createMissionBriefReader } from '../mission-brief/mission-brief-read'
import { locateMissionWorkspace } from '../mission-brief/mission-workspace-location'
import { readRalphMissionsFor } from '../mission-brief/ralph-mission-records'
import { readStateMdRecord } from '../mission-brief/state-md-record'

export function registerMissionBriefHandlers(store: Store): void {
  const read = createMissionBriefReader({
    locate: (workspaceKey) => locateMissionWorkspace(store, workspaceKey),
    gsdAvailable: () => gsdToolsAvailable(),
    runGsd: createGsdRunner(),
    listDirs,
    fileExists,
    readStateRecord: readStateMdRecord,
    readMissions: (workspacePath) => readRalphMissionsFor(workspacePath),
    readGitHead,
    fingerprint: planningFingerprint,
    now: Date.now
  })
  ipcMain.removeHandler('missionBrief:read')
  ipcMain.handle(
    'missionBrief:read',
    (_event, request: unknown): Promise<MissionBriefResult> => read(request)
  )
}
