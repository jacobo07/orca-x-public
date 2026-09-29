import { join } from 'node:path'

import type {
  BacklogCandidateListQuery,
  BacklogCandidateListResult,
  BacklogHealth,
  BacklogListQuery,
  BacklogListResult,
  BacklogLoadResult,
  BacklogWriteOutcome
} from '../../shared/backlog-outcomes'
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
import {
  resolveBacklogCandidate,
  type BacklogCandidateResolution,
  type BacklogResolveResult
} from './backlog-candidate-resolution'
import { BACKLOG_CANDIDATE_CODEC } from './backlog-candidate-validation'
import { mintBacklogEvidenceId, mintBacklogItemId } from './backlog-identity-mint'
import {
  applyBacklogItemPatch,
  applyBacklogItemTransition,
  type BacklogItemPatch,
  type BacklogTransitionInput
} from './backlog-item-folds'
import {
  mergeBacklogItems,
  type BacklogItemMergeInput,
  type BacklogItemMergeResult
} from './backlog-item-merge'
import { BACKLOG_ITEM_CODEC } from './backlog-item-validation'
import { openBacklogLedger } from './backlog-ledger-open'
import {
  queryBacklogCandidates,
  queryBacklogItems,
  summarizeBacklogHealth
} from './backlog-ledger-queries'
import { BacklogRecordQueue } from './backlog-record-queue'
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
  resolutions: BacklogRecordQueue
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
        ),
        resolutions: new BacklogRecordQueue()
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

  resolveCandidate(resolution: BacklogCandidateResolution): Promise<BacklogResolveResult> {
    return resolveBacklogCandidate(this.stores(), resolution)
  }

  mergeItems(input: BacklogItemMergeInput): Promise<BacklogItemMergeResult> {
    return mergeBacklogItems(this.stores().items, input)
  }

  // Each read side call is a fresh scan of the current root: no in-memory index to go stale.
  async list(query: BacklogListQuery): Promise<BacklogListResult> {
    const ledger = await openBacklogLedger(this.rootDirectory())
    return ledger.outcome === 'opened' ? queryBacklogItems(ledger, query) : ledger
  }

  async listCandidates(query: BacklogCandidateListQuery): Promise<BacklogCandidateListResult> {
    const ledger = await openBacklogLedger(this.rootDirectory())
    return ledger.outcome === 'opened' ? queryBacklogCandidates(ledger, query) : ledger
  }

  async health(): Promise<BacklogHealth> {
    const ledger = await openBacklogLedger(this.rootDirectory())
    return ledger.outcome === 'opened' ? summarizeBacklogHealth(ledger) : ledger
  }
}
