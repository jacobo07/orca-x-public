import type {
  BacklogHarvestSkipCounts,
  BacklogHarvestSkipReason
} from '../../../shared/backlog-harvest-report'
import {
  BACKLOG_HARVEST_MARKERS_PER_MESSAGE,
  BACKLOG_HARVEST_MIN_INTENT_CHARS
} from '../../../shared/backlog-harvest-limits'
import { BACKLOG_TEXT_MAX } from '../../../shared/backlog-rpc-limits'
import { normalizeIntentForFingerprint } from './candidate-fingerprint'
import { isFenceLine, isQuotedLine, matchIntentMarker } from './intent-marker-vocabulary'

// Pure over the { role, blocks } shape Orca records and native transcripts share: no clock, no I/O.

export type IntentSourceMessage = {
  id: string
  role: string
  blocks: readonly { type: string; text?: string }[]
  timestamp?: number | null
  seq?: number
}

/** Whether the last user message's turn can still change; each source derives it from its own record. */
export type LastTurnState = 'settled' | 'unsettled' | 'unknown'

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

function joinedText(message: IntentSourceMessage): string | null {
  const parts = message.blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
  return parts.length === 0 ? null : parts.join('\n')
}

// Only user prose is the Owner's intent; assistant, tool and system text never is (D-01).
function userText(message: IntentSourceMessage): string | null {
  return message.role === 'user' ? joinedText(message) : null
}

// A settled turn is not an answered one: only assistant prose after the ask counts as an answer.
function isAssistantAnswer(message: IntentSourceMessage): boolean {
  return message.role === 'assistant' && (joinedText(message)?.trim() ?? '') !== ''
}

function inOrder(messages: readonly IntentSourceMessage[]): IntentSourceMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => (a.message.seq ?? a.index) - (b.message.seq ?? b.index) || a.index - b.index)
    .map((entry) => entry.message)
}

class IntentCollector {
  readonly intents: ExtractedIntent[] = []
  readonly skipped: BacklogHarvestSkipCounts = {}

  skip(reason: BacklogHarvestSkipReason, count = 1): void {
    this.skipped[reason] = (this.skipped[reason] ?? 0) + count
  }

  /** Length rules: too short carries no intent; too long is skipped, never cut. */
  admits(text: string): boolean {
    if (normalizeIntentForFingerprint(text).length < BACKLOG_HARVEST_MIN_INTENT_CHARS) {
      this.skip('too-short')
      return false
    }
    if (text.length > BACKLOG_TEXT_MAX) {
      this.skip('text-too-long')
      return false
    }
    return true
  }

  /** Returns how many marker lines the message carried, admitted or not. */
  collectMarkers(message: IntentSourceMessage, text: string): number {
    let markers = 0
    let emitted = 0
    let inFence = false
    for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
      if (isFenceLine(line)) {
        inFence = !inFence
        continue
      }
      const match = inFence || isQuotedLine(line) ? null : matchIntentMarker(line)
      if (match === null) {
        continue
      }
      markers += 1
      if ('empty' in match) {
        this.skip('too-short')
      } else if (emitted >= BACKLOG_HARVEST_MARKERS_PER_MESSAGE) {
        this.skip('markers-over-limit')
      } else if (this.admits(match.payload)) {
        emitted += 1
        this.intents.push({
          messageId: message.id,
          lineIndex,
          text: match.payload,
          uncertainty: 'medium',
          capturedAt: message.timestamp ?? null
        })
      }
    }
    return markers
  }
}

export function extractConversationIntents(
  messages: readonly IntentSourceMessage[],
  options: { lastTurnState?: LastTurnState } = {}
): IntentExtraction {
  const ordered = inOrder(messages)
  const collector = new IntentCollector()
  let lastUserIndex = -1
  let lastUserMarkers = 0
  for (const [index, message] of ordered.entries()) {
    const text = userText(message)
    if (text !== null) {
      lastUserIndex = index
      lastUserMarkers = collector.collectMarkers(message, text)
    }
  }
  if (lastUserIndex === -1) {
    collector.skip('no-user-text')
    return { intents: collector.intents, skipped: collector.skipped }
  }
  const lastUser = ordered[lastUserIndex]
  const answered = ordered.slice(lastUserIndex + 1).some(isAssistantAnswer)
  // Markers already carry the explicit intent; the whole message would record it twice.
  if (!answered && lastUserMarkers === 0) {
    if ((options.lastTurnState ?? 'unknown') !== 'settled') {
      collector.skip('turn-unsettled')
    } else {
      const ask = (userText(lastUser) ?? '').trim()
      if (collector.admits(ask)) {
        collector.intents.push({
          messageId: lastUser.id,
          lineIndex: null,
          text: ask,
          uncertainty: 'high',
          capturedAt: lastUser.timestamp ?? null
        })
      }
    }
  }
  return { intents: collector.intents, skipped: collector.skipped }
}
