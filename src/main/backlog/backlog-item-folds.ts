import { checkBacklogCompletion, isBacklogTransitionLegal } from '../../shared/backlog-lifecycle'
import type { BacklogRefusal } from '../../shared/backlog-outcomes'
import type {
  BacklogEvidence,
  BacklogExecutionLink,
  BacklogExecutorPolicy,
  BacklogItem,
  BacklogItemKind,
  BacklogItemState,
  BacklogPriority,
  BacklogProjectRef
} from '../../shared/backlog-types'
import type { BacklogFoldContext } from './backlog-record-store'

export type BacklogEvidenceInput = Omit<BacklogEvidence, 'id' | 'observedAt'> & {
  observedAt?: number
}

export type BacklogItemPatch = {
  normalizedIntent?: string
  kind?: BacklogItemKind
  priority?: BacklogPriority
  projectRefs?: BacklogProjectRef[]
  dependencies?: string[]
  executorPolicy?: BacklogExecutorPolicy | null
  addEvidence?: BacklogEvidenceInput[]
  addExecutionLinks?: BacklogExecutionLink[]
}

export type BacklogTransitionInput = { to: BacklogItemState; reason?: string | null }

function refuse(code: BacklogRefusal['code'], detail: string | null = null): BacklogRefusal {
  return { outcome: 'refused', code, detail }
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

type Replaceable = 'normalizedIntent' | 'kind' | 'priority' | 'projectRefs' | 'dependencies' | 'executorPolicy'
const REPLACEABLE: readonly Replaceable[] = [
  'normalizedIntent',
  'kind',
  'priority',
  'projectRefs',
  'dependencies',
  'executorPolicy'
]

/** Returns the item itself when nothing changes, so the store answers `unchanged` with no event. */
export function applyBacklogItemPatch(
  item: BacklogItem,
  patch: BacklogItemPatch,
  ctx: BacklogFoldContext,
  mintEvidenceId: () => string
): BacklogItem | BacklogRefusal {
  if (patch.kind !== undefined && patch.kind !== item.kind && item.state === 'done') {
    return refuse('kind-change-while-done')
  }
  if (patch.addEvidence?.some((row) => row.class === 'PROVEN' && row.origin === 'model')) {
    return refuse('model-evidence-proven')
  }
  if (patch.dependencies?.includes(item.id)) {
    return refuse('self-dependency')
  }

  const changes: Partial<BacklogItem> = {}
  const fields: string[] = []
  for (const key of REPLACEABLE) {
    const next = patch[key]
    if (next !== undefined && !sameJson(next, item[key])) {
      Object.assign(changes, { [key]: next })
      fields.push(key)
    }
  }
  if (patch.addEvidence && patch.addEvidence.length > 0) {
    const added = patch.addEvidence.map(
      (row): BacklogEvidence => ({ ...row, id: mintEvidenceId(), observedAt: row.observedAt ?? ctx.now })
    )
    changes.evidence = [...item.evidence, ...added]
    fields.push('evidence')
  }
  const newLinks = (patch.addExecutionLinks ?? []).filter(
    (link, index, all) =>
      !item.executionLinks.some((have) => have.kind === link.kind && have.ref === link.ref) &&
      all.findIndex((other) => other.kind === link.kind && other.ref === link.ref) === index
  )
  if (newLinks.length > 0) {
    changes.executionLinks = [...item.executionLinks, ...newLinks]
    fields.push('executionLinks')
  }
  if (fields.length === 0) {
    return item
  }
  return {
    ...item,
    ...changes,
    updatedAt: ctx.now,
    events: [
      ...item.events,
      { id: ctx.mintEventId(), type: 'updated', at: ctx.now, data: { fields: fields.sort() } }
    ]
  }
}

export function applyBacklogItemTransition(
  item: BacklogItem,
  input: BacklogTransitionInput,
  ctx: BacklogFoldContext
): BacklogItem | BacklogRefusal {
  const { to } = input
  if (to === item.state) {
    return item
  }
  if (!isBacklogTransitionLegal(item.state, to)) {
    return refuse('illegal-transition', `${item.state}->${to}`)
  }
  if (to === 'superseded') {
    return refuse('use-merge', 'superseded is set by merge, which names the survivor')
  }
  if (to === 'done') {
    const completion = checkBacklogCompletion(item)
    if (!completion.ok) {
      return refuse(completion.code, completion.detail)
    }
  }
  return {
    ...item,
    state: to,
    updatedAt: ctx.now,
    events: [
      ...item.events,
      {
        id: ctx.mintEventId(),
        type: 'transitioned',
        at: ctx.now,
        data: { from: item.state, to, reason: input.reason ?? null }
      }
    ]
  }
}
