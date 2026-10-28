import { ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

const MAX_REPO_ID_LENGTH = 512
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/

function readRepoId(args: unknown): string {
  const repoId = (args as { repoId?: unknown } | null)?.repoId
  if (typeof repoId !== 'string' || repoId.length === 0 || repoId.length > MAX_REPO_ID_LENGTH) {
    throw new Error('Invalid repoId')
  }
  return repoId
}

function readPrepareArgs(args: unknown): {
  repoSelector: string
  requirementId: string
  approvedContentHash: string
  approvedHostKey: string
} {
  const { requirementId, approvedContentHash, approvedHostKey } = (args ?? {}) as Record<
    string,
    unknown
  >
  if (
    typeof requirementId !== 'string' ||
    requirementId.length === 0 ||
    requirementId.length > 64
  ) {
    throw new Error('Invalid requirementId')
  }
  if (typeof approvedContentHash !== 'string' || !CONTENT_HASH_PATTERN.test(approvedContentHash)) {
    throw new Error('Invalid approvedContentHash')
  }
  if (
    typeof approvedHostKey !== 'string' ||
    approvedHostKey.length === 0 ||
    approvedHostKey.length > 512
  ) {
    throw new Error('Invalid approvedHostKey')
  }
  return {
    repoSelector: `id:${readRepoId(args)}`,
    requirementId,
    approvedContentHash,
    approvedHostKey
  }
}

export function registerEnvironmentRequirementsHandlers(
  runtime: Pick<OrcaRuntimeService, 'measureEnvironmentRequirements' | 'runEnvironmentPrepareStep'>
): void {
  ipcMain.removeHandler('environment:measureRequirements')
  ipcMain.handle('environment:measureRequirements', (_event, args: unknown) =>
    runtime.measureEnvironmentRequirements(`id:${readRepoId(args)}`)
  )
  // Why: this carries a requirement id and a hash, never command text; the runtime re-reads
  // orca.yaml on its host and is the only place a prepare command is spawned.
  ipcMain.removeHandler('environment:runPrepareStep')
  ipcMain.handle('environment:runPrepareStep', (_event, args: unknown) =>
    runtime.runEnvironmentPrepareStep({ ...readPrepareArgs(args), origin: 'desktop-ipc' })
  )
}
