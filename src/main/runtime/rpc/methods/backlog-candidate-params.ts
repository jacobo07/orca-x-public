import { z } from 'zod'

import { isBacklogCandidateId } from '../../../../shared/backlog-identity'
import {
  BACKLOG_FINGERPRINT_MAX,
  BACKLOG_INGEST_BATCH_MAX,
  BACKLOG_NORMALIZED_INTENT_MAX,
  BACKLOG_PROJECT_ID_MAX,
  BACKLOG_PROJECT_REFS_MAX,
  BACKLOG_REF_MAX,
  BACKLOG_SHORT_TEXT_MAX,
  BACKLOG_TEXT_MAX
} from '../../../../shared/backlog-rpc-limits'
import {
  BACKLOG_CANDIDATE_UNCERTAINTIES,
  BACKLOG_ITEM_KINDS,
  BACKLOG_PRIORITIES,
  BACKLOG_SOURCE_CAPABILITY_LEVELS,
  BACKLOG_SOURCE_KINDS
} from '../../../../shared/backlog-types'
import { BacklogItemIdParam, BacklogProjectRefParam } from './backlog-params'

// Identity components are hashed NUL-joined; refused here and again in the operation.
const nulFree = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !value.includes('\0'), 'Must not contain NUL')

const BacklogCandidateIdParam = z.string().refine(isBacklogCandidateId, 'Not a backlog candidate id')

const BacklogCandidateEntryParam = z.object({
  source: z.object({
    kind: z.enum(BACKLOG_SOURCE_KINDS),
    ref: nulFree(BACKLOG_REF_MAX),
    capturedAt: z.number().finite(),
    adapter: z.string().min(1).max(BACKLOG_SHORT_TEXT_MAX),
    capabilityLevel: z.enum(BACKLOG_SOURCE_CAPABILITY_LEVELS)
  }),
  fingerprint: nulFree(BACKLOG_FINGERPRINT_MAX),
  text: z.string().trim().min(1).max(BACKLOG_TEXT_MAX),
  uncertainty: z.enum(BACKLOG_CANDIDATE_UNCERTAINTIES),
  projectHint: z
    .object({
      projectId: z.string().min(1).max(BACKLOG_PROJECT_ID_MAX),
      evidence: z.string().max(BACKLOG_SHORT_TEXT_MAX)
    })
    .optional()
})

export const BacklogCandidatesIngestParams = z.object({
  candidates: z.array(BacklogCandidateEntryParam).min(1).max(BACKLOG_INGEST_BATCH_MAX)
})

const note = z.string().max(BACKLOG_SHORT_TEXT_MAX).optional()

export const BacklogCandidatesResolveParams = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('accept'),
    candidateId: BacklogCandidateIdParam,
    kind: z.enum(BACKLOG_ITEM_KINDS).optional(),
    normalizedIntent: z.string().trim().min(1).max(BACKLOG_NORMALIZED_INTENT_MAX).optional(),
    projectRefs: z.array(BacklogProjectRefParam).max(BACKLOG_PROJECT_REFS_MAX).optional(),
    priority: z.enum(BACKLOG_PRIORITIES).optional(),
    initialState: z.enum(['needs-triage', 'ready']).optional()
  }),
  z.object({
    action: z.literal('merge'),
    candidateId: BacklogCandidateIdParam,
    itemId: BacklogItemIdParam
  }),
  z.object({ action: z.literal('already-done'), candidateId: BacklogCandidateIdParam, note }),
  z.object({ action: z.literal('superseded'), candidateId: BacklogCandidateIdParam, note }),
  z.object({ action: z.literal('dismiss'), candidateId: BacklogCandidateIdParam, note })
])
