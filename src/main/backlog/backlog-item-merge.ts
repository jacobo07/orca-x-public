import { isBacklogTransitionLegal } from '../../shared/backlog-lifecycle'
import { unionBacklogExecutionLinks, unionBacklogSourceLinks } from '../../shared/backlog-merge'
import type { BacklogRefusal, BacklogWriteOutcome } from '../../shared/backlog-outcomes'
import type { BacklogItem } from '../../shared/backlog-types'
import type { BacklogFold, BacklogRecordStore } from './backlog-record-store'

/**
 * `survivor` is the first leg's outcome, or of the precondition that stopped the merge before it;
 * `loser` is null when the second leg never ran.
 */
export type BacklogItemMergeResult = {
  survivor: BacklogWriteOutcome<BacklogItem>
  loser: BacklogWriteOutcome<BacklogItem> | null
}

export type BacklogItemMergeInput = { survivorId: string; loserId: string }

function refuse(code: BacklogRefusal['code'], detail: string | null = null): BacklogRefusal {
  return { outcome: 'refused', code, detail }
}

const isSupersededInto = (item: BacklogItem, survivorId: string): boolean =>
  item.state === 'superseded' && item.mergedInto === survivorId

// Phase-1 decision: only an item with a legal edge to superseded can lose a merge.
function loserRefusal(loser: BacklogItem, survivorId: string): BacklogRefusal | null {
  if (isSupersededInto(loser, survivorId) || isBacklogTransitionLegal(loser.state, 'superseded')) {
    return null
  }
  return refuse('illegal-transition', `${loser.state}->superseded`)
}

function survivorFold(loserId: string, loser: BacklogItem): BacklogFold<BacklogItem> {
  return (current, ctx) => {
    if (current.state === 'superseded') {
      return refuse('merge-target-superseded', current.mergedInto)
    }
    const sourceLinks = unionBacklogSourceLinks(current.sourceLinks, loser.sourceLinks)
    const executionLinks = unionBacklogExecutionLinks(current.executionLinks, loser.executionLinks)
    const alreadyMerged = current.events.some(
      (event) => event.type === 'merged-in' && event.data.from === loserId
    )
    // A retry is a no-op only if the loser gained no link since the first leg (G1).
    if (
      alreadyMerged &&
      sourceLinks.length === current.sourceLinks.length &&
      executionLinks.length === current.executionLinks.length
    ) {
      return current
    }
    return {
      ...current,
      sourceLinks,
      executionLinks,
      updatedAt: ctx.now,
      events: [
        ...current.events,
        { id: ctx.mintEventId(), type: 'merged-in', at: ctx.now, data: { from: loserId } }
      ]
    }
  }
}

function loserFold(survivorId: string): BacklogFold<BacklogItem> {
  return (current, ctx) => {
    if (isSupersededInto(current, survivorId)) {
      return current
    }
    const refusal = loserRefusal(current, survivorId)
    if (refusal !== null) {
      return refusal
    }
    return {
      ...current,
      state: 'superseded',
      mergedInto: survivorId,
      updatedAt: ctx.now,
      events: [
        ...current.events,
        {
          id: ctx.mintEventId(),
          type: 'merged-into',
          at: ctx.now,
          data: { into: survivorId, previousState: current.state }
        }
      ]
    }
  }
}

/** Survivor first: a failure between the legs leaves a duplicate, never a lost link. */
export async function mergeBacklogItems(
  store: BacklogRecordStore<BacklogItem>,
  { survivorId, loserId }: BacklogItemMergeInput
): Promise<BacklogItemMergeResult> {
  if (survivorId === loserId) {
    return { survivor: refuse('self-merge'), loser: null }
  }
  return store.withPair(survivorId, loserId, async (held) => {
    const survivor = await held.load(survivorId)
    if (survivor.outcome !== 'loaded') {
      return { survivor, loser: null }
    }
    const loser = await held.load(loserId)
    if (loser.outcome !== 'loaded') {
      return { survivor: loser, loser: null }
    }
    if (survivor.record.state === 'superseded') {
      return { survivor: refuse('merge-target-superseded', survivor.record.mergedInto), loser: null }
    }
    const refusal = loserRefusal(loser.record, survivorId)
    if (refusal !== null) {
      return { survivor: refusal, loser: null }
    }
    const first = await held.mutate(survivorId, survivorFold(loserId, loser.record))
    if (first.outcome !== 'published' && first.outcome !== 'unchanged') {
      return { survivor: first, loser: null }
    }
    return { survivor: first, loser: await held.mutate(loserId, loserFold(survivorId)) }
  })
}
