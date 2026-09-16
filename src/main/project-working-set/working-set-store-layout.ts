import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { ProjectWorkingSetScope } from '../../shared/project-working-set-types'

/**
 * Where sealed working sets live: `<profile>/project-working-sets/<partition>/<id>.json`.
 *
 * Profile-local like terminal scrollback, so two profiles never share history. The partition is a
 * hash of host and owner key: both are arbitrary strings (a folder key, an SSH target) that must
 * never reach the filesystem raw, and lowercase hex cannot collide under case folding.
 */

const ROOT_DIR_NAME = 'project-working-sets'
const PARTITION_PREFIX = 'v1-'
const ARTIFACT_SUFFIX = '.json'
/** A published artifact whose read-back disagreed with what was submitted. Kept for forensics. */
export const UNVERIFIED_SUFFIX = '.json.unverified'

const ARTIFACT_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/
const UNVERIFIED_NAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json\.unverified$/
// Matches durableWriteTempPath's shape: `<final>.<pid>.<ms>.<hex>.tmp`.
const TEMP_NAME = /\.json\.\d+\.\d+\.[0-9a-f]*\.tmp$/

export function getProfileWorkingSetRoot(profileDataFile: string): string {
  return join(dirname(profileDataFile), ROOT_DIR_NAME)
}

type PartitionKey = Pick<ProjectWorkingSetScope, 'executionHostId' | 'ownerKey'>

export function workingSetPartitionName(scope: PartitionKey): string {
  const hash = createHash('sha256')
    .update(`${scope.executionHostId}\0${scope.ownerKey}`)
    .digest('hex')
    .slice(0, 32)
  return `${PARTITION_PREFIX}${hash}`
}

export function workingSetPartitionDir(root: string, scope: PartitionKey): string {
  return join(root, workingSetPartitionName(scope))
}

/** Ids are minted lowercase by randomUUID; anything else would alias another id on NTFS. */
export function isCanonicalWorkingSetId(id: string): boolean {
  return ARTIFACT_NAME.test(`${id}${ARTIFACT_SUFFIX}`)
}

export function workingSetArtifactName(workingSetId: string): string {
  return `${workingSetId}${ARTIFACT_SUFFIX}`
}

export type WorkingSetDirectoryEntry =
  | { kind: 'artifact'; workingSetId: string }
  | { kind: 'unverified'; workingSetId: string }
  | { kind: 'temp' }
  | { kind: 'unrecognized' }

export function classifyWorkingSetDirectoryEntry(name: string): WorkingSetDirectoryEntry {
  const artifact = ARTIFACT_NAME.exec(name)
  if (artifact) {
    return { kind: 'artifact', workingSetId: artifact[1] }
  }
  const unverified = UNVERIFIED_NAME.exec(name)
  if (unverified) {
    return { kind: 'unverified', workingSetId: unverified[1] }
  }
  return TEMP_NAME.test(name) ? { kind: 'temp' } : { kind: 'unrecognized' }
}
