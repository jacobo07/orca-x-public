// Backlog writes over runtime RPC. A write whose reply is lost answers `unknown` and is never
// re-sent: capture is not idempotent, so the caller refetches instead.
import type { BacklogRefusalCode } from '../../../../shared/backlog-outcomes'
import type {
  BacklogItem,
  BacklogItemKind,
  BacklogItemState,
  BacklogPriority,
  BacklogProjectRef
} from '../../../../shared/backlog-types'
import {
  classifyBacklogHostRefusal,
  sendBacklogRequest,
  toBacklogRecordFailure,
  toBacklogStorageFailed,
  type BacklogClientSettings,
  type BacklogReadFailure,
  type BacklogRecordFailure
} from './backlog-client'
import { hasRuntimeRpcErrorCode } from '../../runtime/runtime-rpc-client'

export type BacklogClientRefusalCode = BacklogRefusalCode | 'invalid-params'

export type BacklogMutationOutcome =
  | { status: 'confirmed'; item: BacklogItem; unchanged: boolean }
  | { status: 'refused'; code: BacklogClientRefusalCode }
  | { status: 'stale' }
  | BacklogRecordFailure
  | BacklogReadFailure
  | { status: 'unknown' }

export type BacklogCaptureRequest = {
  text: string
  kind: BacklogItemKind
  projectRefs?: BacklogProjectRef[]
  priority?: BacklogPriority
  initialState?: 'needs-triage' | 'ready'
}

// originalText is immutable; normalizedIntent is the editable text.
export type BacklogEditablePatch = {
  normalizedIntent?: string
  kind?: BacklogItemKind
  priority?: BacklogPriority
  projectRefs?: BacklogProjectRef[]
}

const EDITABLE_KEYS = ['normalizedIntent', 'kind', 'priority', 'projectRefs'] as const

async function write(
  settings: BacklogClientSettings,
  method: string,
  params: unknown
): Promise<BacklogMutationOutcome> {
  const result = await sendBacklogRequest(settings, method, params)
  if (!result.sent) {
    return result.failure
  }
  if ('thrown' in result) {
    if (hasRuntimeRpcErrorCode(result.thrown, 'invalid_argument')) {
      return { status: 'refused', code: 'invalid-params' }
    }
    return classifyBacklogHostRefusal(result.thrown) ?? { status: 'unknown' }
  }
  const answer = result.answer
  switch (answer.outcome) {
    case 'published':
    case 'unchanged':
      return {
        status: 'confirmed',
        item: answer.record as BacklogItem,
        unchanged: answer.outcome === 'unchanged'
      }
    case 'refused':
      return { status: 'refused', code: answer.code as BacklogRefusalCode }
    case 'superseded':
      return { status: 'stale' }
    case 'storage-failed':
      return toBacklogStorageFailed(answer)
    default:
      return toBacklogRecordFailure(answer) ?? { status: 'unknown' }
  }
}

export function captureBacklogItem(
  settings: BacklogClientSettings,
  input: BacklogCaptureRequest
): Promise<BacklogMutationOutcome> {
  return write(settings, 'backlog.capture', input)
}

export function updateBacklogItem(
  settings: BacklogClientSettings,
  id: string,
  patch: BacklogEditablePatch
): Promise<BacklogMutationOutcome> {
  const editable: BacklogEditablePatch = {}
  for (const key of EDITABLE_KEYS) {
    if (patch[key] !== undefined) {
      Object.assign(editable, { [key]: patch[key] })
    }
  }
  return write(settings, 'backlog.update', { id, patch: editable })
}

export function transitionBacklogItem(
  settings: BacklogClientSettings,
  id: string,
  to: BacklogItemState
): Promise<BacklogMutationOutcome> {
  return write(settings, 'backlog.transition', { id, to })
}
