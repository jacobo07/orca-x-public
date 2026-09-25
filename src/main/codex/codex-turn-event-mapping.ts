// Codex app-server notifications -> the provider-neutral turn vocabulary.
//
// Every name below was OBSERVED on the wire against codex-cli 0.153.4 on 2026-09-21, in a turn
// that asked for a command, had its approval declined, and completed. Names the schema declares
// but no run has produced are deliberately absent: mapping one would be a guess about a payload
// shape nobody has seen, and a wrong guess becomes product content.
//
// Anything unrecognised returns `unmapped`. That is a diagnostic, never a message.

import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import type { NativeChatBlock, NativeChatRole } from '../../shared/native-chat-types'

type Params = Record<string, unknown>

function asRecord(value: unknown): Params | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Params) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Codex item types seen carrying product content, and the role each becomes. */
const ITEM_ROLE: Record<string, NativeChatRole> = {
  userMessage: 'user',
  agentMessage: 'assistant',
  commandExecution: 'tool'
}

function contentBlocks(item: Params): NativeChatBlock[] {
  const type = asString(item.type)
  if (type === 'commandExecution') {
    // The command is the call; its aggregated output is the result. Both observed on
    // item/completed for an execution that was declined.
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'commandExecution', input: item.command ?? null }
    ]
    // Field names from the installed schema's ThreadItem/commandExecution variant, which requires
    // `status` (inProgress | completed | failed | declined) and offers `aggregatedOutput`.
    const output = asString(item.aggregatedOutput)
    const status = asString(item.status)
    if (output !== null || status !== null) {
      blocks.push({
        type: 'tool-result',
        output: output ?? '',
        // A declined command is an error result, not an empty one.
        isError: status !== null && status !== 'completed'
      })
    }
    return blocks
  }
  const text = asString(item.text)
  if (text !== null) {
    return [{ type: 'text', text }]
  }
  // userMessage carries `content: [{type:'text', text}]` rather than a flat `text`.
  const content = Array.isArray(item.content) ? item.content : []
  const texts = content
    .map((entry) => asString(asRecord(entry)?.text))
    .filter((value): value is string => value !== null)
  return texts.map((value) => ({ type: 'text', text: value }))
}

/**
 * @returns the neutral event for one notification, or `unmapped` when this build does not model it.
 */
export function mapCodexNotification(notification: {
  method: string
  params: unknown
}): AgentTurnEvent {
  const params = asRecord(notification.params) ?? {}
  const unmapped: AgentTurnEvent = { kind: 'unmapped', method: notification.method }

  switch (notification.method) {
    case 'turn/started': {
      const turnId = asString(asRecord(params.turn)?.id)
      return turnId ? { kind: 'turn-started', turnId } : unmapped
    }
    case 'turn/completed': {
      // Measured on 0.155.1: a refused turn (usage limit) completes with `status: "failed"` and the
      // provider's own `error`. Only `completed` is a finished answer.
      const turn = asRecord(params.turn)
      const turnId = asString(turn?.id)
      const status = asString(turn?.status)
      if (!turnId) {
        return unmapped
      }
      if (status === null || status === 'completed') {
        return { kind: 'turn-completed', turnId }
      }
      return {
        kind: 'turn-ended',
        turnId,
        state: status === 'interrupted' ? 'interrupted' : 'failed',
        reason: asString(asRecord(turn?.error)?.message) ?? `the provider ended the turn: ${status}`
      }
    }
    case 'item/agentMessage/delta': {
      const itemId = asString(params.itemId)
      const text = asString(params.delta)
      return itemId !== null && text !== null
        ? { kind: 'assistant-delta', turnId: asString(params.turnId), itemId, text }
        : unmapped
    }
    case 'item/completed': {
      const item = asRecord(params.item)
      const itemId = item ? asString(item.id) : null
      const role = item ? ITEM_ROLE[asString(item.type) ?? ''] : undefined
      if (!item || itemId === null || !role) {
        return unmapped
      }
      return {
        kind: 'message-completed',
        turnId: asString(params.turnId),
        itemId,
        role,
        blocks: contentBlocks(item)
      }
    }
    case 'thread/status/changed': {
      const status = asRecord(params.status)
      const type = status ? asString(status.type) : null
      if (type === null) {
        return unmapped
      }
      // activeFlags is where `waitingOnApproval` appears — the user-visible half of the status.
      const flags = Array.isArray(status?.activeFlags) ? status.activeFlags : []
      const detail = flags.length > 0 ? flags.map(String).join(',') : null
      return { kind: 'provider-status', status: type, detail }
    }
    case 'error': {
      // The words live under `error.message` (0.155.1); `message` is the older spelling. An error the
      // provider is retrying has not ended the turn.
      const message =
        asString(asRecord(params.error)?.message) ??
        asString(params.message) ??
        'codex reported an error'
      if (params.willRetry === true) {
        return { kind: 'provider-status', status: 'retrying', detail: message }
      }
      return {
        kind: 'turn-ended',
        turnId: asString(params.turnId),
        state: 'failed',
        reason: message
      }
    }
    default:
      return unmapped
  }
}
