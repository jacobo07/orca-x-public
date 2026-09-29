import { backlogItemCapacityRefusal } from '../../shared/backlog-item-capacity'
import { backlogSourceLinkFromCandidate } from '../../shared/backlog-merge'
import type { BacklogRefusal, BacklogWriteOutcome } from '../../shared/backlog-outcomes'
import {
  BACKLOG_NORMALIZED_INTENT_MAX,
  BACKLOG_SHORT_TEXT_MAX
} from '../../shared/backlog-rpc-limits'
import {
  BACKLOG_SCHEMA_VERSION,
  type BacklogCandidate,
  type BacklogCandidateStatus,
  type BacklogItem,
  type BacklogItemKind,
  type BacklogPriority,
  type BacklogProjectRef
} from '../../shared/backlog-types'
import { mintItemIdForCandidate } from './backlog-identity-mint'
import type { BacklogRecordQueue } from './backlog-record-queue'
import type { BacklogFold, BacklogRecordStore } from './backlog-record-store'

export type BacklogCandidateResolution =
  | {
      action: 'accept'
      candidateId: string
      kind?: BacklogItemKind
      normalizedIntent?: string
      projectRefs?: BacklogProjectRef[]
      priority?: BacklogPriority
      initialState?: 'needs-triage' | 'ready'
    }
  | { action: 'merge'; candidateId: string; itemId: string }
  | { action: 'already-done' | 'superseded' | 'dismiss'; candidateId: string; note?: string | null }

/** A null leg never ran. */
export type BacklogResolveResult = {
  candidate: BacklogWriteOutcome<BacklogCandidate> | null
  item: BacklogWriteOutcome<BacklogItem> | null
}

type Stores = {
  items: BacklogRecordStore<BacklogItem>
  candidates: BacklogRecordStore<BacklogCandidate>
  /** Keyed by candidate id; separate from the candidate store's own queue, which the fold re-enters. */
  resolutions: BacklogRecordQueue
}

const TARGET_STATUS: Record<BacklogCandidateResolution['action'], BacklogCandidateStatus> = {
  accept: 'accepted',
  merge: 'merged',
  'already-done': 'already-done',
  superseded: 'superseded',
  dismiss: 'dismissed'
}

const ALREADY_RESOLVED: BacklogRefusal = {
  outcome: 'refused',
  code: 'candidate-already-resolved',
  detail: null
}

function targetItemId(resolution: BacklogCandidateResolution): string | null {
  if (resolution.action === 'accept') {
    return mintItemIdForCandidate(resolution.candidateId)
  }
  return resolution.action === 'merge' ? resolution.itemId : null
}

// Open, or already exactly where this resolution would put it (a retry).
function isResolvable(candidate: BacklogCandidate, status: BacklogCandidateStatus, itemId: string | null) {
  return (
    candidate.status === 'open' ||
    (candidate.status === status && candidate.resolvedItemId === itemId)
  )
}

function candidateFold(resolution: BacklogCandidateResolution): BacklogFold<BacklogCandidate> {
  const status = TARGET_STATUS[resolution.action]
  const itemId = targetItemId(resolution)
  const note = 'note' in resolution ? (resolution.note ?? null) : null
  return (current, ctx) => {
    if (current.status === status && current.resolvedItemId === itemId) {
      return current
    }
    if (current.status !== 'open') {
      return ALREADY_RESOLVED
    }
    return {
      ...current,
      status,
      resolvedItemId: itemId,
      events: [
        ...current.events,
        {
          id: ctx.mintEventId(),
          type: 'resolved',
          at: ctx.now,
          data: {
            action: resolution.action,
            itemId,
            note: note === null ? null : note.slice(0, BACKLOG_SHORT_TEXT_MAX)
          }
        }
      ]
    }
  }
}

function acceptItem(
  stores: Stores,
  candidate: BacklogCandidate,
  resolution: Extract<BacklogCandidateResolution, { action: 'accept' }>
): Promise<BacklogWriteOutcome<BacklogItem>> {
  const id = mintItemIdForCandidate(candidate.id)
  // A hint is a guess about the project, so it can only ever become an inferred mapping.
  const hinted: BacklogProjectRef[] = candidate.projectHint
    ? [
        {
          projectId: candidate.projectHint.projectId,
          mapping: 'inferred',
          evidence: candidate.projectHint.evidence
        }
      ]
    : []
  return stores.items.create(
    id,
    ({ now, mintEventId }) => ({
      schemaVersion: BACKLOG_SCHEMA_VERSION,
      id,
      kind: resolution.kind ?? 'idea',
      originalText: candidate.text,
      normalizedIntent: (resolution.normalizedIntent ?? candidate.text).slice(
        0,
        BACKLOG_NORMALIZED_INTENT_MAX
      ),
      projectRefs: resolution.projectRefs ?? hinted,
      state: resolution.initialState ?? 'needs-triage',
      priority: resolution.priority ?? 'normal',
      dependencies: [],
      executorPolicy: null,
      sourceLinks: [backlogSourceLinkFromCandidate(candidate)],
      executionLinks: [],
      evidence: [],
      events: [
        {
          id: mintEventId(),
          type: 'created',
          at: now,
          data: { origin: 'candidate', candidateId: candidate.id }
        }
      ],
      mergedInto: null,
      revision: 1,
      createdAt: now,
      updatedAt: now
    }),
    { onExisting: 'unchanged' }
  )
}

function linkCandidateToItem(
  stores: Stores,
  candidate: BacklogCandidate,
  itemId: string
): Promise<BacklogWriteOutcome<BacklogItem>> {
  return stores.items.mutate(itemId, (item, ctx) => {
    if (item.state === 'superseded') {
      return { outcome: 'refused', code: 'merge-target-superseded', detail: item.mergedInto }
    }
    if (item.sourceLinks.some((link) => link.candidateId === candidate.id)) {
      return item
    }
    const sourceLinks = [...item.sourceLinks, backlogSourceLinkFromCandidate(candidate)]
    const overCapacity = backlogItemCapacityRefusal({ ...item, sourceLinks })
    if (overCapacity !== null) {
      return overCapacity
    }
    return {
      ...item,
      sourceLinks,
      updatedAt: ctx.now,
      events: [
        ...item.events,
        {
          id: ctx.mintEventId(),
          type: 'source-linked',
          at: ctx.now,
          data: { candidateId: candidate.id }
        }
      ]
    }
  })
}

/**
 * Item first: a candidate marked accepted or merged with no item behind it would be lost intent,
 * while an item with a still-open candidate is repaired by retrying the same resolution.
 */
export function resolveBacklogCandidate(
  stores: Stores,
  resolution: BacklogCandidateResolution
): Promise<BacklogResolveResult> {
  // Serialized per candidate so the status check below is fresh when the item leg commits.
  return stores.resolutions.run(resolution.candidateId, () => resolveHeld(stores, resolution))
}

async function resolveHeld(
  stores: Stores,
  resolution: BacklogCandidateResolution
): Promise<BacklogResolveResult> {
  const loaded = await stores.candidates.load(resolution.candidateId)
  if (loaded.outcome !== 'loaded') {
    return { candidate: loaded, item: null }
  }
  const candidate = loaded.record
  if (!isResolvable(candidate, TARGET_STATUS[resolution.action], targetItemId(resolution))) {
    return { candidate: ALREADY_RESOLVED, item: null }
  }
  let item: BacklogWriteOutcome<BacklogItem> | null = null
  if (resolution.action === 'accept') {
    item = await acceptItem(stores, candidate, resolution)
  } else if (resolution.action === 'merge') {
    item = await linkCandidateToItem(stores, candidate, resolution.itemId)
  }
  if (item !== null && item.outcome !== 'published' && item.outcome !== 'unchanged') {
    return { candidate: null, item }
  }
  const settled = await stores.candidates.mutate(candidate.id, candidateFold(resolution))
  return { candidate: settled, item }
}
