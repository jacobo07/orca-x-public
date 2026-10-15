import { ipcMain } from 'electron'
import type {
  ReplicaPairCompareResult,
  ReplicaPairRelationsResult
} from '../../shared/replica-pair-view'
import { readReplicaPairService } from '../replica-pair-service-slot'

const MAX_ID_LENGTH = 512

function readId(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new Error(`Invalid ${name}`)
  }
  return value
}

function readCompareArgs(args: unknown): { projectId: string; setupId?: string } {
  const { projectId, setupId } = (args ?? {}) as Record<string, unknown>
  const validProjectId = readId(projectId, 'projectId')
  return setupId === undefined
    ? { projectId: validProjectId }
    : { projectId: validProjectId, setupId: readId(setupId, 'setupId') }
}

// Why: the service slot is read per call, so a service installed after registration is still used.
export function registerReplicaPairHandlers(): void {
  ipcMain.removeHandler('replicaPair:compare')
  ipcMain.handle(
    'replicaPair:compare',
    async (_event, args: unknown): Promise<ReplicaPairCompareResult> => {
      const request = readCompareArgs(args)
      const service = readReplicaPairService()
      return service
        ? service.compare(request)
        : { status: 'unavailable', reason: 'no-replica-service' }
    }
  )
  ipcMain.removeHandler('replicaPair:relations')
  ipcMain.handle('replicaPair:relations', async (): Promise<ReplicaPairRelationsResult> => {
    const service = readReplicaPairService()
    return service ? service.relations() : { status: 'unavailable', reason: 'no-replica-service' }
  })
}
