import { createHash, randomUUID } from 'node:crypto'

import {
  BACKLOG_CANDIDATE_ID_PREFIX,
  BACKLOG_EVENT_ID_PREFIX,
  BACKLOG_EVIDENCE_ID_PREFIX,
  BACKLOG_ITEM_ID_PREFIX
} from '../../shared/backlog-identity'

export function mintBacklogItemId(): string {
  return `${BACKLOG_ITEM_ID_PREFIX}${randomUUID()}`
}

export function mintBacklogEventId(): string {
  return `${BACKLOG_EVENT_ID_PREFIX}${randomUUID()}`
}

export function mintBacklogEvidenceId(): string {
  return `${BACKLOG_EVIDENCE_ID_PREFIX}${randomUUID()}`
}

/** Idempotency contract for every harvester run: changing it re-ingests history as new candidates. */
export function deriveBacklogCandidateId(
  sourceKind: string,
  sourceRef: string,
  fingerprint: string
): string {
  // NUL is the hash separator; callers validate first, so reaching here with one is a bug.
  if ([sourceKind, sourceRef, fingerprint].some((part) => part.includes('\0'))) {
    throw new Error('Backlog candidate identity components must not contain NUL')
  }
  const digest = createHash('sha256')
    .update(`${sourceKind}\0${sourceRef}\0${fingerprint}`)
    .digest('hex')
  return `${BACKLOG_CANDIDATE_ID_PREFIX}${digest.slice(0, 32)}`
}

/** Accepting one candidate always targets one item file, so a retried accept cannot mint a second. */
export function mintItemIdForCandidate(candidateId: string): string {
  const hex = createHash('sha256').update(`bli\0${candidateId}`).digest('hex').slice(0, 32)
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  return `${BACKLOG_ITEM_ID_PREFIX}${uuid}`
}
