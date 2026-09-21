import type { IPtyProvider } from './types'
import { inspectPtyProviderProcessForRenderer } from './pty-process-inspection'
import {
  PTY_PROCESS_INSPECTION_BATCH_MAX_IDS,
  type PtyProcessInspectionBatchEntry
} from '../../shared/pty-process-inspection-batch'

// Why: one hung host must not hold every other pane's backstop answer.
export const PTY_PROCESS_INSPECTION_BATCH_SUBJECT_TIMEOUT_MS = 10_000

function readIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) {
    return []
  }
  const unique = new Set<string>()
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0) {
      unique.add(id)
    }
  }
  return [...unique].slice(0, PTY_PROCESS_INSPECTION_BATCH_MAX_IDS)
}

async function inspectOne(
  getProvider: (id: string) => IPtyProvider,
  id: string,
  timeoutMs: number
): Promise<PtyProcessInspectionBatchEntry> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    const inspection = await Promise.race([
      inspectPtyProviderProcessForRenderer(getProvider(id), id),
      timedOut
    ])
    return inspection ? { id, status: 'inspected', inspection } : { id, status: 'failed' }
  } catch {
    return { id, status: 'failed' }
  } finally {
    clearTimeout(timer)
  }
}

/** One renderer request, one answer per pane; the providers are still asked per pane. */
export async function inspectPtyProcessesForRenderer(
  ids: unknown,
  getProvider: (id: string) => IPtyProvider,
  timeoutMs = PTY_PROCESS_INSPECTION_BATCH_SUBJECT_TIMEOUT_MS
): Promise<PtyProcessInspectionBatchEntry[]> {
  return Promise.all(readIds(ids).map((id) => inspectOne(getProvider, id, timeoutMs)))
}
