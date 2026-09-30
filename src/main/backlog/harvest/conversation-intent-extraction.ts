import type { BacklogHarvestSkipCounts } from '../../../shared/backlog-harvest-report'

// Pure over the { role, blocks } shape Orca records and native transcripts share: no clock, no I/O.

export type IntentSourceMessage = {
  id: string
  role: string
  blocks: readonly { type: string; text?: string }[]
  timestamp?: number | null
}

export type ExtractedIntent = {
  messageId: string
  lineIndex: number | null
  text: string
  uncertainty: 'medium' | 'high'
  capturedAt: number | null
}

export type IntentExtraction = {
  intents: ExtractedIntent[]
  skipped: BacklogHarvestSkipCounts
}

const UNCHECKED_BOX = /^\s*[-*+]\s+\[ \]\s+(.+)$/

// Only user prose is the Owner's intent; assistant, tool and system text never is (D-01).
function userText(message: IntentSourceMessage): string | null {
  if (message.role !== 'user') {
    return null
  }
  const parts = message.blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
  return parts.length === 0 ? null : parts.join('\n')
}

export function extractConversationIntents(
  messages: readonly IntentSourceMessage[]
): IntentExtraction {
  const intents: ExtractedIntent[] = []
  for (const message of messages) {
    const text = userText(message)
    if (text === null) {
      continue
    }
    for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
      const match = UNCHECKED_BOX.exec(line)
      if (match) {
        intents.push({
          messageId: message.id,
          lineIndex,
          text: match[1].trim(),
          uncertainty: 'medium',
          capturedAt: message.timestamp ?? null
        })
      }
    }
  }
  return { intents, skipped: {} }
}
