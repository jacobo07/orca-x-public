import { z } from 'zod'

import { isBacklogItemId } from '../../../../shared/backlog-identity'
import {
  BACKLOG_DEPENDENCIES_MAX,
  BACKLOG_EVIDENCE_PER_UPDATE_MAX,
  BACKLOG_NORMALIZED_INTENT_MAX,
  BACKLOG_PROJECT_ID_MAX,
  BACKLOG_PROJECT_REFS_MAX,
  BACKLOG_REF_MAX,
  BACKLOG_SHORT_TEXT_MAX,
  BACKLOG_TEXT_MAX
} from '../../../../shared/backlog-rpc-limits'
import {
  BACKLOG_EVIDENCE_CLASSES,
  BACKLOG_EVIDENCE_ORIGINS,
  BACKLOG_EVIDENCE_SUBJECTS,
  BACKLOG_EXECUTION_LINK_KINDS,
  BACKLOG_ITEM_KINDS,
  BACKLOG_ITEM_STATES,
  BACKLOG_LANES,
  BACKLOG_PRIORITIES,
  BACKLOG_PROJECT_MAPPINGS
} from '../../../../shared/backlog-types'

// Plain z.object strips unknown keys: a caller cannot send id, revision or events.
const BacklogItemIdParam = z.string().refine(isBacklogItemId, 'Not a backlog item id')

export const BacklogGetParams = z.object({ id: BacklogItemIdParam })

const BacklogProjectRefParam = z.object({
  projectId: z.string().min(1).max(BACKLOG_PROJECT_ID_MAX),
  mapping: z.enum(BACKLOG_PROJECT_MAPPINGS),
  evidence: z.string().max(BACKLOG_SHORT_TEXT_MAX)
})

export const BacklogCaptureParams = z.object({
  text: z.string().trim().min(1, 'A backlog item needs text').max(BACKLOG_TEXT_MAX),
  kind: z.enum(BACKLOG_ITEM_KINDS),
  normalizedIntent: z.string().trim().min(1).max(BACKLOG_NORMALIZED_INTENT_MAX).optional(),
  projectRefs: z.array(BacklogProjectRefParam).max(BACKLOG_PROJECT_REFS_MAX).optional(),
  priority: z.enum(BACKLOG_PRIORITIES).optional(),
  initialState: z.enum(['needs-triage', 'ready']).optional()
})

// PROVEN + origin model is deliberately NOT refined away here: the store is the authority.
const BacklogEvidenceParam = z.object({
  class: z.enum(BACKLOG_EVIDENCE_CLASSES),
  origin: z.enum(BACKLOG_EVIDENCE_ORIGINS),
  subject: z.enum(BACKLOG_EVIDENCE_SUBJECTS),
  source: z.string().min(1).max(BACKLOG_SHORT_TEXT_MAX),
  ref: z.string().min(1).max(BACKLOG_REF_MAX).nullable(),
  observedAt: z.number().finite().optional()
})

const BacklogExecutionLinkParam = z.object({
  kind: z.enum(BACKLOG_EXECUTION_LINK_KINDS),
  ref: z.string().min(1).max(BACKLOG_REF_MAX)
})

const BacklogPatchParam = z
  .object({
    normalizedIntent: z.string().trim().min(1).max(BACKLOG_NORMALIZED_INTENT_MAX).optional(),
    kind: z.enum(BACKLOG_ITEM_KINDS).optional(),
    priority: z.enum(BACKLOG_PRIORITIES).optional(),
    projectRefs: z.array(BacklogProjectRefParam).max(BACKLOG_PROJECT_REFS_MAX).optional(),
    dependencies: z.array(BacklogItemIdParam).max(BACKLOG_DEPENDENCIES_MAX).optional(),
    executorPolicy: z
      .object({ preferred: z.enum(BACKLOG_LANES), fallback: z.enum(BACKLOG_LANES).nullable() })
      .nullable()
      .optional(),
    addEvidence: z.array(BacklogEvidenceParam).max(BACKLOG_EVIDENCE_PER_UPDATE_MAX).optional(),
    addExecutionLinks: z
      .array(BacklogExecutionLinkParam)
      .max(BACKLOG_EVIDENCE_PER_UPDATE_MAX)
      .optional()
  })
  .refine((patch) => Object.keys(patch).length > 0, 'A patch needs at least one field')

export const BacklogUpdateParams = z.object({ id: BacklogItemIdParam, patch: BacklogPatchParam })

export const BacklogTransitionParams = z.object({
  id: BacklogItemIdParam,
  to: z.enum(BACKLOG_ITEM_STATES),
  reason: z.string().max(BACKLOG_SHORT_TEXT_MAX).optional()
})
