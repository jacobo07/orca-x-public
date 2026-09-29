import { join } from 'node:path'

import type { BacklogLoadResult, BacklogWriteOutcome } from '../../shared/backlog-outcomes'
import { BACKLOG_NORMALIZED_INTENT_MAX } from '../../shared/backlog-rpc-limits'
import {
  BACKLOG_SCHEMA_VERSION,
  type BacklogCandidate,
  type BacklogItem,
  type BacklogItemKind,
  type BacklogPriority,
  type BacklogProjectRef
} from '../../shared/backlog-types'
import {
  ingestBacklogCandidates,
  type BacklogCandidateIngestEntry,
  type BacklogIngestEntryResult
} from './backlog-candidate-operations'
import { BACKLOG_CANDIDATE_CODEC } from './backlog-candidate-validation'
import { mintBacklogEvidenceId, mintBacklogItemId } from './backlog-identity-mint'
import {
  applyBacklogItemPatch,
  applyBacklogItemTransition,
  type BacklogItemPatch,
  type BacklogTransitionInput
} from './backlog-item-folds'
import { BACKLOG_ITEM_CODEC } from './backlog-item-validation'
import { BacklogRecordStore } from './backlog-record-store'

export type BacklogCaptureInput = {
  text: string
  kind: BacklogItemKind
  normalizedIntent?: string
  projectRefs?: BacklogProjectRef[]
  priority?: BacklogPriority
  initialState?: 'needs-triage' | 'ready'
}

type StoreSet = {
  items: BacklogRecordStore<BacklogItem>
  candidates: BacklogRecordStore<BacklogCandidate>
}

export class BacklogService {
  private readonly storesByRoot = new Map<string, StoreSet>()
  private readonly now: () => number

  constructor(
    private readonly rootDirectory: () => string,
    options: { now?: () => number } = {}
  ) {
    this.now = options.now ?? Date.now
  }

  // Resolved per call so a profile switch takes effect on the next operation.
  private stores(): StoreSet {
    const root = this.rootDirectory()
    let entry = this.storesByRoot.get(root)
    if (!entry) {
      entry = {
        items: new BacklogRecordStore(join(root, 'items'), BACKLOG_ITEM_CODEC, this.now),
        candidates: new BacklogRecordStore(
          join(root, 'candidates'),
          BACKLOG_CANDIDATE_CODEC,
          this.now
        )
      }
      this.storesByRoot.set(root, entry)
    }
    return entry
  }

  capture(input: BacklogCaptureInput): Promise<BacklogWriteOutcome<BacklogItem>> {
    const id = mintBacklogItemId()
    const text = input.text.trim()
    return this.stores().items.create(
      id,
      ({ now, mintEventId }) => ({
        schemaVersion: BACKLOG_SCHEMA_VERSION,
        id,
        kind: input.kind,
        originalText: text,
        normalizedIntent: (input.normalizedIntent ?? text).slice(0, BACKLOG_NORMALIZED_INTENT_MAX),
        projectRefs: input.projectRefs ?? [],
        state: input.initialState ?? 'needs-triage',
        priority: input.priority ?? 'normal',
        dependencies: [],
        executorPolicy: null,
        // The ref is unique per capture: a constant would make two manual links identical and a
        // later merge union would collapse them.
        sourceLinks: [{ kind: 'manual', ref: id, capturedAt: now, candidateId: null }],
        executionLinks: [],
        evidence: [],
        events: [{ id: mintEventId(), type: 'created', at: now, data: { origin: 'manual' } }],
        mergedInto: null,
        revision: 1,
        createdAt: now,
        updatedAt: now
      }),
      { onExisting: 'superseded' }
    )
  }

  get(id: string): Promise<BacklogLoadResult<BacklogItem>> {
    return this.stores().items.load(id)
  }

  update(id: string, patch: BacklogItemPatch): Promise<BacklogWriteOutcome<BacklogItem>> {
    return this.stores().items.mutate(id, (current, ctx) =>
      applyBacklogItemPatch(current, patch, ctx, mintBacklogEvidenceId)
    )
  }

  transition(
    id: string,
    input: BacklogTransitionInput
  ): Promise<BacklogWriteOutcome<BacklogItem>> {
    return this.stores().items.mutate(id, (current, ctx) =>
      applyBacklogItemTransition(current, input, ctx)
    )
  }

  ingestCandidates(
    entries: readonly BacklogCandidateIngestEntry[]
  ): Promise<BacklogIngestEntryResult[]> {
    return ingestBacklogCandidates(this.stores().candidates, entries)
  }
}
