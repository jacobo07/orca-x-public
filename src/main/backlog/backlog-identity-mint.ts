import { randomUUID } from 'node:crypto'

import {
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
