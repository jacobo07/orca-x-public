import { BACKLOG_HARVEST_CONVERSATIONS_PER_RUN } from '../../../shared/backlog-harvest-limits'
import type {
  BacklogHarvestCapHit,
  BacklogHarvestSkipCounts,
  BacklogHarvestSkipReason
} from '../../../shared/backlog-harvest-report'
import { BACKLOG_OPEN_CONCURRENCY } from '../../../shared/backlog-rpc-limits'
import {
  isConversationTurnSettled,
  type ConversationId,
  type ConversationLoadResult,
  type ConversationRecord
} from '../../../shared/conversation-types'
import { mapSettledWithConcurrency } from '../../../shared/map-with-concurrency'
import type { BacklogCandidateIngestEntry } from '../backlog-candidate-operations'
import { deriveHarvestFingerprint } from './candidate-fingerprint'
import { extractConversationIntents, type LastTurnState } from './conversation-intent-extraction'
import {
  ingestHarvestedCandidates,
  type HarvestIngestPort,
  type HarvestUnitResult
} from './harvest-ingest-pipeline'

export const ORCA_CONVERSATION_HARVEST_ADAPTER = 'orca-conversation-harvest.v1'

/** Read-only port: the harvester never appends to or saves a conversation. */
export type BacklogConversationSource = {
  listIds: () => Promise<ConversationId[]>
  read: (id: ConversationId) => Promise<ConversationLoadResult>
}

export function conversationSourceFromStore(store: {
  list: () => Promise<ConversationId[]>
  load: (id: ConversationId) => Promise<ConversationLoadResult>
}): BacklogConversationSource {
  return { listIds: () => store.list(), read: (id) => store.load(id) }
}

function addSkip(skipped: BacklogHarvestSkipCounts, reason: BacklogHarvestSkipReason, count = 1) {
  skipped[reason] = (skipped[reason] ?? 0) + count
}

// A user message outside any recorded turn cannot prove its turn ended, so it is unknown.
function lastTurnStateOf(record: ConversationRecord): LastTurnState {
  const lastUser = record.messages.findLast((message) => message.role === 'user')
  const turn = record.turns.find((candidate) => candidate.turnId === lastUser?.turnId)
  if (!turn) {
    return 'unknown'
  }
  return isConversationTurnSettled(turn.state) ? 'settled' : 'unsettled'
}

function entriesOf(record: ConversationRecord, skipped: BacklogHarvestSkipCounts) {
  const extraction = extractConversationIntents(record.messages, {
    lastTurnState: lastTurnStateOf(record)
  })
  for (const [reason, count] of Object.entries(extraction.skipped)) {
    addSkip(skipped, reason as BacklogHarvestSkipReason, count ?? 0)
  }
  return extraction.intents.map((intent): BacklogCandidateIngestEntry => {
    const lineSuffix = intent.lineIndex === null ? '' : `#L${intent.lineIndex}`
    const ref = `${record.id}#${intent.messageId}${lineSuffix}`
    return {
      source: {
        kind: 'orca-conversation',
        ref,
        capturedAt: intent.capturedAt ?? record.updatedAt,
        adapter: ORCA_CONVERSATION_HARVEST_ADAPTER,
        capabilityLevel: 'full'
      },
      fingerprint: deriveHarvestFingerprint('orca-conversation', ref, intent.text),
      text: intent.text,
      uncertainty: intent.uncertainty,
      // Inferred from the record's own binding; accepting it is the human's call.
      projectHint:
        record.projectId === null
          ? null
          : { projectId: record.projectId, evidence: 'conversation.projectId' }
    }
  })
}

export async function harvestOrcaConversations(
  source: BacklogConversationSource,
  port: HarvestIngestPort
): Promise<HarvestUnitResult> {
  let listed: ConversationId[]
  try {
    listed = await source.listIds()
  } catch {
    // A directory that cannot be listed is not an empty one; the store already maps ENOENT to [].
    return { outcome: 'refused', code: 'source-unreadable' }
  }
  // Sorted for a stable cut: the port has no modification time to rank by.
  const all = [...listed].sort()
  const ids = all.slice(0, BACKLOG_HARVEST_CONVERSATIONS_PER_RUN)
  const sourcesCap: BacklogHarvestCapHit | null =
    all.length > ids.length
      ? { code: 'sources-per-run', notScanned: all.length - ids.length, kept: 'first-by-id' }
      : null
  const skipped: BacklogHarvestSkipCounts = {}
  const loads = await mapSettledWithConcurrency(ids, BACKLOG_OPEN_CONCURRENCY, (id) =>
    source.read(id)
  )
  const entries: BacklogCandidateIngestEntry[] = []
  let read = 0
  for (const settled of loads) {
    const loaded: ConversationLoadResult =
      settled.status === 'fulfilled'
        ? settled.value
        : { outcome: 'unreadable', reason: 'read threw' }
    if (loaded.outcome === 'loaded') {
      read += 1
      entries.push(...entriesOf(loaded.record, skipped))
    } else {
      addSkip(skipped, loaded.outcome === 'absent' ? 'vanished' : loaded.outcome)
    }
  }
  const tally = await ingestHarvestedCandidates(port, entries, 'first-by-id')
  // One cap slot: the source cap bit first, so it is the one reported when both are hit.
  const cap = sourcesCap ?? tally.cap
  return { outcome: 'scanned', seen: all.length, read, skipped, cap, tally }
}
