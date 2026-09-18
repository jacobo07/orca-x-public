import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { readProjectWorkingSetManifest } from '../../shared/project-working-set-schema'
import type {
  WorkingSetArtifactOutcome,
  WorkingSetHistory,
  WorkingSetHistoryItem,
  WorkingSetSaveOutcome,
  WorkingSetScopeKey,
  WorkingSetScrollbackSealReport
} from '../../shared/project-working-set-store-types'
import type { ProjectWorkingSetManifest } from '../../shared/project-working-set-types'
import type { TerminalScrollbackSnapshotStorage } from '../terminal-scrollback-snapshots'
import {
  DurablePublishError,
  durableWriteTempPath,
  syncDirectory,
  writeFileDurableExclusive
} from '../durable-file-write'
import {
  classifyWorkingSetDirectoryEntry,
  isCanonicalWorkingSetId,
  UNVERIFIED_SUFFIX,
  workingSetArtifactName,
  workingSetPartitionDir,
  workingSetPartitionName
} from './working-set-store-layout'
import {
  discardWorkingSetScrollback,
  sealWorkingSetScrollback
} from './working-set-scrollback-seal'

/**
 * The durable owner of sealed working sets. Saving never touches a terminal: it persists
 * composition only, and "saved" means the published file was read back through the same reader
 * recovery will use and matched what was submitted.
 */

/** Far above any real manifest; bounds what one listing can hold in memory. */
export const WORKING_SET_ARTIFACT_BYTE_LIMIT = 4 * 1024 * 1024

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : 'UNKNOWN'
}

/** The canonical disk reader: the save gate and every listing go through this and nothing else. */
export async function readWorkingSetArtifact(
  root: string,
  scope: WorkingSetScopeKey,
  workingSetId: string
): Promise<WorkingSetArtifactOutcome> {
  if (!isCanonicalWorkingSetId(workingSetId)) {
    return { status: 'missing' }
  }
  const path = join(workingSetPartitionDir(root, scope), workingSetArtifactName(workingSetId))
  let text: string
  try {
    const info = await stat(path)
    if (info.size > WORKING_SET_ARTIFACT_BYTE_LIMIT) {
      return { status: 'corrupt', reason: 'oversize', detail: `${info.size} bytes` }
    }
    text = await readFile(path, 'utf-8')
  } catch (error) {
    const code = errorCode(error)
    return code === 'ENOENT' ? { status: 'missing' } : { status: 'unreadable', code }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { status: 'corrupt', reason: 'unparseable', detail: workingSetId }
  }
  const outcome = readProjectWorkingSetManifest(raw)
  if (outcome.status !== 'valid') {
    return outcome
  }
  const { manifest } = outcome
  if (
    manifest.workingSetId !== workingSetId ||
    manifest.scope.executionHostId !== scope.executionHostId ||
    manifest.scope.ownerKey !== scope.ownerKey
  ) {
    return { status: 'corrupt', reason: 'misplaced', detail: workingSetId }
  }
  return outcome
}

function publishFailure(error: unknown, workingSetId: string): WorkingSetSaveOutcome {
  if (!(error instanceof DurablePublishError)) {
    return { status: 'write-failed', code: errorCode(error) }
  }
  if (error.stage === 'write') {
    return { status: 'write-failed', code: error.code }
  }
  if (error.stage === 'barrier') {
    return { status: 'durability-failed', code: error.code }
  }
  return error.code === 'EEXIST'
    ? { status: 'identity-collision', workingSetId }
    : { status: 'publish-failed', code: error.code }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false
    }
    throw error
  }
}

export async function saveProjectWorkingSet(
  root: string,
  candidate: unknown,
  scrollbackStorage: TerminalScrollbackSnapshotStorage
): Promise<WorkingSetSaveOutcome> {
  const validated = readProjectWorkingSetManifest(candidate)
  if (validated.status === 'unsupported-version') {
    return { status: 'refused-unsupported-version', manifestVersion: validated.manifestVersion }
  }
  if (validated.status === 'corrupt') {
    return { status: 'refused-invalid', reason: validated.reason, detail: validated.detail }
  }
  const { manifest } = validated
  const { workingSetId, scope } = manifest
  if (!isCanonicalWorkingSetId(workingSetId)) {
    return { status: 'refused-invalid', reason: 'non-canonical-id', detail: workingSetId }
  }
  const partitionDir = workingSetPartitionDir(root, scope)
  const finalPath = join(partitionDir, workingSetArtifactName(workingSetId))
  // Why the validated copy: strict parsing already dropped nothing, so this is exactly what was checked.
  const payload = JSON.stringify(manifest)
  let scrollback: WorkingSetScrollbackSealReport
  try {
    // Why before sealing: copies filed under an id another manifest owns would be discarded with ours.
    if (await pathExists(finalPath)) {
      return { status: 'identity-collision', workingSetId }
    }
    const created = await mkdir(partitionDir, { recursive: true, mode: 0o700 })
    if (created) {
      // Why: a freshly created directory's own entry must survive too, or the file goes with it.
      await syncDirectory(dirname(partitionDir))
      await syncDirectory(dirname(root))
    }
    // Why first: the manifest is the durable pointer and these copies are its referents.
    scrollback = await sealWorkingSetScrollback(root, manifest, scrollbackStorage)
    await writeFileDurableExclusive(durableWriteTempPath(finalPath), finalPath, payload, {
      mode: 0o600
    })
  } catch (error) {
    const failure = publishFailure(error, workingSetId)
    if (failure.status !== 'identity-collision') {
      await discardWorkingSetScrollback(root, scope, workingSetId)
    }
    return failure
  }
  const readBack = await readWorkingSetArtifact(root, scope, workingSetId)
  if (readBack.status === 'unreadable' || readBack.status === 'missing') {
    return { status: 'read-back-failed', workingSetId, artifact: readBack }
  }
  if (readBack.status === 'valid' && isDeepStrictEqual(readBack.manifest, manifest)) {
    return { status: 'saved', workingSetId, bytes: Buffer.byteLength(payload), scrollback }
  }
  const quarantined = await rename(
    finalPath,
    `${finalPath.slice(0, -'.json'.length)}${UNVERIFIED_SUFFIX}`
  )
    .then(() => true)
    .catch(() => false)
  if (quarantined) {
    await discardWorkingSetScrollback(root, scope, workingSetId)
  }
  return { status: 'verify-failed', workingSetId, quarantined }
}

export function compareWorkingSetsNewestFirst(
  a: ProjectWorkingSetManifest,
  b: ProjectWorkingSetManifest
): number {
  if (a.createdAt !== b.createdAt) {
    return b.createdAt - a.createdAt
  }
  return a.workingSetId < b.workingSetId ? -1 : a.workingSetId > b.workingSetId ? 1 : 0
}

export async function listProjectWorkingSets(
  root: string,
  scope: WorkingSetScopeKey
): Promise<WorkingSetHistory> {
  let names: string[]
  try {
    names = await readdir(join(root, workingSetPartitionName(scope)))
  } catch (error) {
    const code = errorCode(error)
    return code === 'ENOENT'
      ? {
          status: 'listed',
          valid: [],
          latestWorkingSetId: null,
          problems: [],
          tempArtifactCount: 0
        }
      : { status: 'unreadable', code }
  }
  const valid: ProjectWorkingSetManifest[] = []
  const problems: WorkingSetHistoryItem[] = []
  let tempArtifactCount = 0
  // Why sequential: artifacts are small but unbounded in count; one at a time bounds memory.
  for (const name of [...names].sort()) {
    const entry = classifyWorkingSetDirectoryEntry(name)
    if (entry.kind === 'temp') {
      tempArtifactCount++
    } else if (entry.kind === 'unrecognized') {
      problems.push({ fileName: name, outcome: { status: 'unrecognized' } })
    } else if (entry.kind === 'unverified') {
      problems.push({ workingSetId: entry.workingSetId, outcome: { status: 'unverified' } })
    } else {
      const outcome = await readWorkingSetArtifact(root, scope, entry.workingSetId)
      if (outcome.status === 'valid') {
        valid.push(outcome.manifest)
      } else {
        problems.push({ workingSetId: entry.workingSetId, outcome })
      }
    }
  }
  valid.sort(compareWorkingSetsNewestFirst)
  return {
    status: 'listed',
    valid,
    latestWorkingSetId: valid[0]?.workingSetId ?? null,
    problems,
    tempArtifactCount
  }
}
