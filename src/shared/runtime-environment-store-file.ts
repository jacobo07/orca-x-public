import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecureJsonFileWithinLimit } from './bounded-secure-json-file'
import { JsonStringifyByteLimitError } from './node-bounded-json-stringify'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'
import {
  KnownRuntimeEnvironmentSchema,
  RuntimeEnvironmentStoreSchema,
  type RuntimeEnvironmentStore
} from './runtime-environments'
import { hardenExistingSecureFile } from './secure-file'

const ENVIRONMENTS_FILE = 'orca-environments.json'
export const ENVIRONMENTS_BACKUP_SUFFIX = '.bak'
export const MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES = 1024 * 1024

export type RuntimeEnvironmentStoreErrorCode = 'invalid_argument' | 'runtime_error'

export class RuntimeEnvironmentStoreError extends Error {
  readonly code: RuntimeEnvironmentStoreErrorCode

  constructor(code: RuntimeEnvironmentStoreErrorCode, message: string) {
    super(message)
    this.name = 'RuntimeEnvironmentStoreError'
    this.code = code
  }
}

export function getEnvironmentStorePath(userDataPath: string): string {
  return join(userDataPath, ENVIRONMENTS_FILE)
}

// Why its own type: only bytes that are not JSON mean damage. A valid file from a newer Orca, an oversized file or a
// read error must refuse, because restoring over them would replace good data with an older backup.
class UndecodableEnvironmentStoreError extends Error {}

function parseEnvironmentStoreFile(path: string): RuntimeEnvironmentStore {
  hardenExistingSecureFile(path)
  const text = readNodeFileSyncWithinLimit(
    path,
    MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES
  ).buffer.toString('utf8')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new UndecodableEnvironmentStoreError(path)
  }
  const parsed = RuntimeEnvironmentStoreSchema.parse(json)
  return {
    version: 1,
    environments: parsed.environments
      .map((entry) => KnownRuntimeEnvironmentSchema.parse(entry))
      .sort((a, b) => a.name.localeCompare(b.name))
  }
}

function unreadableStore(path: string): RuntimeEnvironmentStoreError {
  return new RuntimeEnvironmentStoreError(
    'runtime_error',
    `Could not read Orca environments at ${path}; the file is invalid.`
  )
}

// Why publish over the damaged file instead of moving it first: the primary must never be absent, or a failure here
// would read as an empty store and the next save would overwrite the only good copy.
function restoreFromBackup(path: string): RuntimeEnvironmentStore {
  const store = parseEnvironmentStoreFile(`${path}${ENVIRONMENTS_BACKUP_SUFFIX}`)
  if (existsSync(path)) {
    try {
      // Why: another Orca process may have restored it while this one was reading.
      return parseEnvironmentStoreFile(path)
    } catch (error) {
      if (!(error instanceof UndecodableEnvironmentStoreError)) {
        throw error
      }
    }
    const damaged = `${path}.corrupt-${Date.now()}`
    copyFileSync(path, damaged)
    hardenExistingSecureFile(damaged)
  }
  writeDurableStoreFile(path, store)
  console.warn(`[environments] ${path} was damaged or missing; restored it from its backup.`)
  return store
}

export function readEnvironmentStore(userDataPath: string): RuntimeEnvironmentStore {
  const path = getEnvironmentStorePath(userDataPath)
  const hasBackup = existsSync(`${path}${ENVIRONMENTS_BACKUP_SUFFIX}`)
  if (!existsSync(path) && !hasBackup) {
    return { version: 1, environments: [] }
  }
  try {
    if (existsSync(path)) {
      return parseEnvironmentStoreFile(path)
    }
  } catch (error) {
    if (!(error instanceof UndecodableEnvironmentStoreError) || !hasBackup) {
      throw unreadableStore(path)
    }
  }
  try {
    return restoreFromBackup(path)
  } catch (error) {
    console.warn(`[environments] could not restore ${path} from its backup:`, error)
    throw unreadableStore(path)
  }
}

// Why durable: without the flush, a power cut can publish the renamed file with its data still unwritten, which left
// one host with every pairing token replaced by zero bytes.
function writeDurableStoreFile(path: string, store: RuntimeEnvironmentStore): void {
  writeSecureJsonFileWithinLimit(path, store, MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES, {
    durable: true
  })
}

// Why the new state and not the old: a removed server's token must not linger in the backup. A failure here must not
// report the committed change as failed, and no backup is safer than a stale one that a recovery could bring back.
function writeEnvironmentBackup(path: string, store: RuntimeEnvironmentStore): void {
  const backup = `${path}${ENVIRONMENTS_BACKUP_SUFFIX}`
  try {
    writeDurableStoreFile(backup, store)
  } catch (error) {
    console.warn(`[environments] could not update ${backup}; removing it:`, error)
    try {
      rmSync(backup, { force: true })
    } catch (removeError) {
      // Why swallowed: the save is already committed, and throwing would report it as failed.
      console.warn(`[environments] could not remove ${backup}; it is stale:`, removeError)
    }
  }
}

export function writeEnvironmentStore(
  userDataPath: string,
  store: RuntimeEnvironmentStore,
  options: { backup?: boolean } = {}
): void {
  const path = getEnvironmentStorePath(userDataPath)
  try {
    const parsed = RuntimeEnvironmentStoreSchema.parse(store)
    writeDurableStoreFile(path, parsed)
    if (options.backup !== false) {
      writeEnvironmentBackup(path, parsed)
    }
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      throw new RuntimeEnvironmentStoreError(
        'runtime_error',
        `Could not write Orca environments at ${path}; the store exceeds its durable capacity.`
      )
    }
    throw error
  }
}
