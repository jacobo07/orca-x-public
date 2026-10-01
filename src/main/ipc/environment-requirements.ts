import { ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

const MAX_REPO_ID_LENGTH = 512

export function registerEnvironmentRequirementsHandlers(
  runtime: Pick<OrcaRuntimeService, 'measureEnvironmentRequirements'>
): void {
  ipcMain.removeHandler('environment:measureRequirements')
  ipcMain.handle('environment:measureRequirements', (_event, args: unknown) => {
    const repoId = (args as { repoId?: unknown } | null)?.repoId
    if (typeof repoId !== 'string' || repoId.length === 0 || repoId.length > MAX_REPO_ID_LENGTH) {
      throw new Error('Invalid repoId')
    }
    return runtime.measureEnvironmentRequirements(`id:${repoId}`)
  })
}
