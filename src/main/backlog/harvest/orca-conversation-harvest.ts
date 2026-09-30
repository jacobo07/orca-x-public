import type { BacklogHarvestSkipCounts } from '../../../shared/backlog-harvest-report'
import { BACKLOG_OPEN_CONCURRENCY } from '../../../shared/backlog-rpc-limits'
import type {
  ConversationId,
  ConversationLoadResult,
  ConversationRecord
} from '../../../shared/conversation-types'
import { mapSettledWithConcurrency } from '../../../shared/map-with-concurrency'
import type { BacklogCandidateIngestEntry } from '../backlog-candidate-operations'
import { deriveHarvestFingerprint } from './candidate-fingerprint'
import { extractConversationIntents } from './conversation-intent-extraction'
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

function addSkip(skipped: BacklogHarvestSkipCounts, reason: keyof BacklogHarvestSkipCounts): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1
}

function entriesOf(record: ConversationRecord, skipped: BacklogHarvestSkipCounts) {
  const extraction = extractConversationIntents(record.messages)
  for (const [reason, count] of Object.entries(extraction.skipped)) {
    const key = reason as keyof BacklogHarvestSkipCounts
    skipped[key] = (skipped[key] ?? 0) + (count ?? 0)
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
  const ids = [...(await source.listIds())].sort()
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
  const tally = await ingestHarvestedCandidates(port, entries)
  return { outcome: 'scanned', seen: ids.length, read, skipped, cap: null, tally }
}
