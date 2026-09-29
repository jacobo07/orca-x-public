import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { BacklogRefusal, BacklogStorageFailure } from '../../shared/backlog-outcomes'
import { BACKLOG_RECORD_MAX_BYTES } from '../../shared/backlog-rpc-limits'
import {
  DurablePublishError,
  durableWriteTempPath,
  writeFileDurableIfCurrent
} from '../durable-file-write'

const RECORD_SUFFIX = '.json'

export type BacklogRawRead =
  | { outcome: 'text'; text: string }
  | { outcome: 'absent' }
  | { outcome: 'unreadable'; code: 'read-failed' | 'too-large'; reason: string }

/** A bad id is a programmer error and throws; it is never reported as a corrupt record. */
export function backlogRecordPath(
  directory: string,
  id: string,
  isId: (value: unknown) => boolean
): string {
  if (!isId(id) || id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error('Refusing to build a backlog record path from a malformed id')
  }
  return join(directory, `${id}${RECORD_SUFFIX}`)
}

export async function readBacklogRecordText(finalPath: string): Promise<BacklogRawRead> {
  try {
    const info = await stat(finalPath)
    if (info.size > BACKLOG_RECORD_MAX_BYTES) {
      return { outcome: 'unreadable', code: 'too-large', reason: `record is ${info.size} bytes` }
    }
    return { outcome: 'text', text: await readFile(finalPath, 'utf-8') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { outcome: 'absent' }
    }
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown'
    return { outcome: 'unreadable', code: 'read-failed', reason: `read failed (${code})` }
  }
}

export function serializeBacklogRecord(
  record: unknown
): { payload: string } | (BacklogRefusal & { payload?: undefined }) {
  const payload = `${JSON.stringify(record, null, 2)}\n`
  if (Buffer.byteLength(payload, 'utf-8') > BACKLOG_RECORD_MAX_BYTES) {
    return { outcome: 'refused', code: 'record-too-large', detail: null }
  }
  return { payload }
}

/** Publishes a record that must not already exist; 'exists' means another writer got there first. */
export async function publishNewBacklogRecord(
  finalPath: string,
  payload: string
): Promise<'published' | 'exists' | BacklogStorageFailure> {
  try {
    await mkdir(dirname(finalPath), { recursive: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { outcome: 'storage-failed', stage: 'prepare', code: typeof code === 'string' ? code : null }
  }
  try {
    const published = await writeFileDurableIfCurrent(
      durableWriteTempPath(finalPath),
      finalPath,
      payload,
      () => !existsSync(finalPath)
    )
    return published ? 'published' : 'exists'
  } catch (error) {
    if (error instanceof DurablePublishError) {
      return { outcome: 'storage-failed', stage: error.stage, code: error.code }
    }
    throw error
  }
}

/** Null matches no expectation, so an unreadable file refuses a publish rather than permitting it. */
export function readOnDiskBacklogRevision(finalPath: string): number | null {
  try {
    const revision = (JSON.parse(readFileSync(finalPath, 'utf-8')) as { revision?: unknown }).revision
    return typeof revision === 'number' && Number.isInteger(revision) ? revision : null
  } catch {
    return null
  }
}
