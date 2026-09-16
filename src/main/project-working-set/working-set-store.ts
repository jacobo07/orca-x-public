import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  readProjectWorkingSetManifest,
  type WorkingSetCorruptReason
} from '../../shared/project-working-set-schema'
import type {
  ProjectWorkingSetManifest,
  ProjectWorkingSetScope
} from '../../shared/project-working-set-types'
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

/**
 * The durable owner of sealed working sets. Saving never touches a terminal: it persists
 * composition only, and "saved" means the published file was read back through the same reader
 * recovery will use and matched what was submitted.
 */

/** Far above any real manifest; bounds what one listing can hold in memory. */
export const WORKING_SET_ARTIFACT_BYTE_LIMIT = 4 * 1024 * 1024

export type WorkingSetScopeKey = Pick<ProjectWorkingSetScope, 'executionHostId' | 'ownerKey'>

export type WorkingSetStoreCorruptReason =
  | WorkingSetCorruptReason
  | 'unparseable'
  | 'oversize'
  /** Valid content whose id or scope does not belong at this path. */
  | 'misplaced'

export type WorkingSetArtifactOutcome =
  | { status: 'valid'; manifest: ProjectWorkingSetManifest }
  | { status: 'unsupported-version'; manifestVersion: number }
  | { status: 'corrupt'; reason: WorkingSetStoreCorruptReason; detail: string }
  | { status: 'unreadable'; code: string }
  | { status: 'missing' }

export type WorkingSetSaveOutcome =
  | { status: 'saved'; workingSetId: string; bytes: number }
  | {
      status: 'refused-invalid'
      reason: WorkingSetCorruptReason | 'non-canonical-id'
      detail: string
    }
  | { status: 'refused-unsupported-version'; manifestVersion: number }
  | { status: 'identity-collision'; workingSetId: string }
  | { status: 'write-failed'; code: string | null }
  | { status: 'durability-failed'; code: string | null }
  | { status: 'publish-failed'; code: string | null }
  /** Published, but this operation could not prove it; a later listing may still find it valid. */
  | { status: 'read-back-failed'; workingSetId: string; artifact: WorkingSetArtifactOutcome }
  /** Published and read, but not what was submitted; moved aside so history never lists it. */
  | { status: 'verify-failed'; workingSetId: string; quarantined: boolean }

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

export async function saveProjectWorkingSet(
  root: string,
  candidate: unknown
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
  try {
    const created = await mkdir(partitionDir, { recursive: true, mode: 0o700 })
    if (created) {
      // Why: a freshly created directory's own entry must survive too, or the file goes with it.
      await syncDirectory(dirname(partitionDir))
      await syncDirectory(dirname(root))
    }
    await writeFileDurableExclusive(durableWriteTempPath(finalPath), finalPath, payload, {
      mode: 0o600
    })
  } catch (error) {
    return publishFailure(error, workingSetId)
  }
  const readBack = await readWorkingSetArtifact(root, scope, workingSetId)
  if (readBack.status === 'unreadable' || readBack.status === 'missing') {
    return { status: 'read-back-failed', workingSetId, artifact: readBack }
  }
  if (readBack.status === 'valid' && isDeepStrictEqual(readBack.manifest, manifest)) {
    return { status: 'saved', workingSetId, bytes: Buffer.byteLength(payload) }
  }
  const quarantined = await rename(
    finalPath,
    `${finalPath.slice(0, -'.json'.length)}${UNVERIFIED_SUFFIX}`
  )
    .then(() => true)
    .catch(() => false)
  return { status: 'verify-failed', workingSetId, quarantined }
}

export type WorkingSetHistoryItem =
  | { workingSetId: string; outcome: WorkingSetArtifactOutcome }
  | { workingSetId: string; outcome: { status: 'unverified' } }
  | { fileName: string; outcome: { status: 'unrecognized' } }

export type WorkingSetHistory =
  | {
      status: 'listed'
      /** Valid manifests, newest first; ties broken by id so the order never depends on readdir. */
      valid: ProjectWorkingSetManifest[]
      latestWorkingSetId: string | null
      /** Everything that is not a valid manifest, named only by what its path proves. */
      problems: WorkingSetHistoryItem[]
      tempArtifactCount: number
    }
  | { status: 'unreadable'; code: string }

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
