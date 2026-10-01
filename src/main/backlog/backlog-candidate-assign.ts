import type { BacklogRefusal, BacklogWriteOutcome } from '../../shared/backlog-outcomes'
import {
  BACKLOG_SCHEMA_VERSION,
  type BacklogCandidate,
  type BacklogProjectHint
} from '../../shared/backlog-types'
import type { BacklogRecordQueue } from './backlog-record-queue'
import type { BacklogFold, BacklogRecordStore } from './backlog-record-store'

export type BacklogCandidateAssignment = { candidateId: string; projectId: string | null }

type Stores = {
  candidates: BacklogRecordStore<BacklogCandidate>
  resolutions: BacklogRecordQueue
}

// The Owner's choice is the whole evidence; there is no source fact behind an assignment.
const ASSIGNED_EVIDENCE = 'assigned'

const ALREADY_RESOLVED: BacklogRefusal = {
  outcome: 'refused',
  code: 'candidate-already-resolved',
  detail: null
}

function nextHint(projectId: string | null): BacklogProjectHint | null {
  return projectId === null ? null : { projectId, evidence: ASSIGNED_EVIDENCE, mapping: 'explicit' }
}

function isSameHint(current: BacklogProjectHint | null, projectId: string | null): boolean {
  if (projectId === null) {
    return current === null
  }
  return current?.projectId === projectId && current.mapping === 'explicit'
}

function assignFold(projectId: string | null): BacklogFold<BacklogCandidate> {
  return (current, ctx) => {
    if (current.status !== 'open') {
      return ALREADY_RESOLVED
    }
    if (isSameHint(current.projectHint, projectId)) {
      return current
    }
    return {
      ...current,
      // The only v2 writer: older builds quarantine exactly the records carrying this event.
      schemaVersion: BACKLOG_SCHEMA_VERSION,
      projectHint: nextHint(projectId),
      events: [
        ...current.events,
        {
          id: ctx.mintEventId(),
          type: 'hint-assigned',
          at: ctx.now,
          data: { projectId, previousProjectId: current.projectHint?.projectId ?? null }
        }
      ]
    }
  }
}

/** Open only, and on the resolve queue so a resolution can never be followed by a hint change. */
export function assignBacklogCandidate(
  stores: Stores,
  assignment: BacklogCandidateAssignment
): Promise<BacklogWriteOutcome<BacklogCandidate>> {
  return stores.resolutions.run(assignment.candidateId, () =>
    stores.candidates.mutate(assignment.candidateId, assignFold(assignment.projectId))
  )
}
