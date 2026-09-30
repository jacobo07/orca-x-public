import { BACKLOG_HARVEST_EXPORT_CONVERSATIONS_MAX } from '../../../shared/backlog-harvest-limits'
import type {
  BacklogHarvestCapHit,
  BacklogHarvestSkipCounts,
  BacklogHarvestSkipReason
} from '../../../shared/backlog-harvest-report'
import type { IntentSourceMessage } from './conversation-intent-extraction'

/**
 * Pure parse of a ChatGPT account export's `conversations.json` (no fs, no clock). The file's internal
 * shape is ASSUMED from research Q3, never observed, so every result is UNVERIFIED-ON-REAL-EXPORT (D-13).
 */

export type ParsedChatGptConversation = {
  id: string
  updatedAt: number | null
  /** The active thread (current_node back to the root), root-first; ids are mapping node ids. */
  messages: IntentSourceMessage[]
}

export type ChatGptExportParse =
  | { outcome: 'refused'; code: 'not-json' | 'not-an-export' }
  | {
      outcome: 'parsed'
      seen: number
      conversations: ParsedChatGptConversation[]
      skipped: BacklogHarvestSkipCounts
      cap: BacklogHarvestCapHit | null
    }

type JsonObject = Record<string, unknown>

const TEXT_CONTENT_TYPES = new Set(['text', 'multimodal_text'])

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function secondsToMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** current_node back to the root; null when a node is missing or the chain revisits a node. */
function activeThread(mapping: JsonObject, currentNode: string): JsonObject[] | null {
  const path: JsonObject[] = []
  const visited = new Set<string>()
  let nodeId: string | null = currentNode
  while (nodeId !== null) {
    const node = Object.hasOwn(mapping, nodeId) ? mapping[nodeId] : undefined
    if (visited.has(nodeId) || !isObject(node)) {
      return null
    }
    visited.add(nodeId)
    path.push({ ...node, id: nodeId })
    nodeId = nonEmptyString(node.parent)
  }
  return path.toReversed()
}

// Custom instructions are authored as role user and hidden context is not what the user typed (D-12).
function messageOf(
  nodeId: string,
  message: unknown,
  updatedAt: number | null
): IntentSourceMessage | null {
  if (!isObject(message) || !isObject(message.author) || !isObject(message.content)) {
    return null
  }
  const role = nonEmptyString(message.author.role)
  const contentType = message.content.content_type
  if (role === null || typeof contentType !== 'string' || !TEXT_CONTENT_TYPES.has(contentType)) {
    return null
  }
  if (
    isObject(message.metadata) &&
    message.metadata.is_visually_hidden_from_conversation === true
  ) {
    return null
  }
  const parts = Array.isArray(message.content.parts)
    ? message.content.parts.filter((part): part is string => typeof part === 'string')
    : []
  if (parts.length === 0) {
    return null
  }
  return {
    id: nodeId,
    role,
    blocks: [{ type: 'text', text: parts.join('\n') }],
    timestamp: secondsToMs(message.create_time) ?? updatedAt
  }
}

function conversationOf(
  member: unknown
): ParsedChatGptConversation | { skip: BacklogHarvestSkipReason } {
  if (!isObject(member)) {
    return { skip: 'not-an-object' }
  }
  const id = nonEmptyString(member.id) ?? nonEmptyString(member.conversation_id)
  if (id === null) {
    return { skip: 'missing-id' }
  }
  if (!isObject(member.mapping)) {
    return { skip: 'missing-mapping' }
  }
  const currentNode = nonEmptyString(member.current_node)
  const thread = currentNode === null ? null : activeThread(member.mapping, currentNode)
  if (thread === null) {
    return { skip: 'broken-thread' }
  }
  const updatedAt = secondsToMs(member.update_time)
  const messages: IntentSourceMessage[] = []
  for (const node of thread) {
    const message = messageOf(node.id as string, node.message, updatedAt)
    if (message !== null) {
      messages.push(message)
    }
  }
  return { id, updatedAt, messages }
}

export function parseChatGptExport(text: string): ChatGptExportParse {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return { outcome: 'refused', code: 'not-json' }
  }
  if (!Array.isArray(root)) {
    return { outcome: 'refused', code: 'not-an-export' }
  }
  const kept = root.slice(0, BACKLOG_HARVEST_EXPORT_CONVERSATIONS_MAX)
  const conversations: ParsedChatGptConversation[] = []
  const skipped: BacklogHarvestSkipCounts = {}
  for (const member of kept) {
    const result = conversationOf(member)
    if ('skip' in result) {
      skipped[result.skip] = (skipped[result.skip] ?? 0) + 1
    } else {
      conversations.push(result)
    }
  }
  return {
    outcome: 'parsed',
    seen: root.length,
    conversations,
    skipped,
    cap:
      root.length > kept.length
        ? { code: 'sources-per-run', notScanned: root.length - kept.length, kept: 'first-in-file' }
        : null
  }
}
