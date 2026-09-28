// Write-side refusals. These run BEFORE the durability barrier, so state that must never become
// durable never reaches the disk at all — rather than being written and then regretted.

import {
  isDurableConversationRole,
  isConversationTurnSettled,
  type ConversationMessage,
  type ConversationRecord
} from '../../shared/conversation-types'
import type { NativeChatMessage } from '../../shared/native-chat-types'

export class NonDurableConversationStateError extends Error {}

/** Drop the messages that must not be persisted, deliberately and at a named call site.
 *  The store refuses them instead of stripping silently, so removal is always someone's decision:
 *  a silent strip inside the writer would make hidden reasoning look like it was never produced. */
export function stripNonDurableMessages<T extends { role: NativeChatMessage['role'] }>(
  messages: readonly T[]
): T[] {
  return messages.filter((message) => isDurableConversationRole(message.role))
}

function assertDurableMessages(messages: readonly ConversationMessage[]): void {
  const offending = messages.find((message) => !isDurableConversationRole(message.role))
  if (offending) {
    throw new NonDurableConversationStateError(
      `Refusing to persist a '${offending.role}' message: hidden provider reasoning is not ` +
        'product-visible state. Call stripNonDurableMessages() at the ingest boundary.'
    )
  }
}

function assertOrdering(record: ConversationRecord): void {
  for (const message of record.messages) {
    if (message.seq >= record.nextSeq) {
      throw new NonDurableConversationStateError(
        `Refusing to persist message ${message.id}: seq ${message.seq} is at or beyond the ` +
          `ordering watermark ${record.nextSeq}, so a later append would reuse it.`
      )
    }
  }
  // A settled turn with no end time cannot be distinguished later from one still running, which
  // is exactly the partial-turn ambiguity the lifecycle exists to remove.
  for (const turn of record.turns) {
    if (isConversationTurnSettled(turn.state) && turn.endedAt === null) {
      throw new NonDurableConversationStateError(
        `Refusing to persist turn ${turn.turnId}: state '${turn.state}' is settled but carries no end time.`
      )
    }
  }
}

export function assertDurableConversationRecord(record: ConversationRecord): void {
  assertDurableMessages(record.messages)
  assertOrdering(record)
}
