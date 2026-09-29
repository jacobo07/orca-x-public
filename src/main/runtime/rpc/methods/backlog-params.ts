import { z } from 'zod'

import { isBacklogItemId } from '../../../../shared/backlog-identity'
import {
  BACKLOG_NORMALIZED_INTENT_MAX,
  BACKLOG_PROJECT_ID_MAX,
  BACKLOG_PROJECT_REFS_MAX,
  BACKLOG_SHORT_TEXT_MAX,
  BACKLOG_TEXT_MAX
} from '../../../../shared/backlog-rpc-limits'
import {
  BACKLOG_ITEM_KINDS,
  BACKLOG_PRIORITIES,
  BACKLOG_PROJECT_MAPPINGS
} from '../../../../shared/backlog-types'

// Plain z.object strips unknown keys: a caller cannot send id, revision or events.
export const BacklogGetParams = z.object({
  id: z.string().refine(isBacklogItemId, 'Not a backlog item id')
})

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
