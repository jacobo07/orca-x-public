import { describe, expect, it } from 'vitest'

import { BACKLOG_INGEST_BATCH_MAX, BACKLOG_TEXT_MAX } from '../../../../shared/backlog-rpc-limits'
import type { RpcContext } from '../core'
import { BACKLOG_METHODS } from './backlog'
import {
  BacklogCandidatesIngestParams,
  BacklogCandidatesResolveParams
} from './backlog-candidate-params'
import {
  BacklogCaptureParams,
  BacklogMergeParams,
  BacklogTransitionParams,
  BacklogUpdateParams
} from './backlog-params'

// Ratchet: later plans extend this list when they add methods.
const NAMES = [
  'backlog.capture',
  'backlog.get',
  'backlog.update',
  'backlog.transition',
  'backlog.candidates.ingest',
  'backlog.candidates.resolve',
  'backlog.merge'
]

const ITEM_ID = 'bli_00000000-0000-4000-8000-000000000000'
const OTHER_ITEM_ID = 'bli_00000000-0000-4000-8000-000000000001'
const CANDIDATE_ID = `blc_${'a'.repeat(32)}`

const CANDIDATE = {
  source: {
    kind: 'orca-conversation',
    ref: 'conv_1',
    capturedAt: 1,
    adapter: 'orca-conversations',
    capabilityLevel: 'full'
  },
  fingerprint: 'fp',
  text: 'Harvested intent',
  uncertainty: 'unknown'
}

const VALID_PARAMS: Record<string, unknown> = {
  'backlog.capture': { text: 'Ship it', kind: 'engineering' },
  'backlog.get': { id: ITEM_ID },
  'backlog.update': { id: ITEM_ID, patch: { priority: 'high' } },
  'backlog.transition': { id: ITEM_ID, to: 'ready' },
  'backlog.candidates.ingest': { candidates: [CANDIDATE] },
  'backlog.candidates.resolve': { action: 'dismiss', candidateId: CANDIDATE_ID },
  'backlog.merge': { survivorId: ITEM_ID, loserId: OTHER_ITEM_ID }
}

function ctxWithoutHost(): RpcContext {
  return {
    runtime: { getBacklogHost: () => null } as unknown as RpcContext['runtime'],
    connectionId: 'conn-1',
    clientKind: 'runtime'
  }
}

describe('backlog.* runtime methods', () => {
  it('registers exactly the ledger method set', () => {
    expect(BACKLOG_METHODS.map((entry) => entry.name).sort()).toEqual([...NAMES].sort())
    expect(NAMES).toHaveLength(7)
  })

  it('answers capability_unsupported on a host with no backlog host (fails closed)', async () => {
    let checked = 0
    for (const entry of BACKLOG_METHODS) {
      const method = entry as unknown as {
        handler: (params: unknown, ctx: RpcContext) => Promise<unknown>
      }
      await expect(
        method.handler(VALID_PARAMS[entry.name], ctxWithoutHost()),
        entry.name
      ).rejects.toMatchObject({ code: 'capability_unsupported' })
      checked += 1
    }
    expect(checked).toBe(NAMES.length)
  })

  it('bounds capture text and strips caller-chosen identity keys', () => {
    expect(
      BacklogCaptureParams.safeParse({ text: 'x'.repeat(BACKLOG_TEXT_MAX + 1), kind: 'idea' })
        .success
    ).toBe(false)
    expect(BacklogCaptureParams.safeParse({ text: '   ', kind: 'idea' }).success).toBe(false)

    const parsed = BacklogCaptureParams.safeParse({
      text: 'Ship it',
      kind: 'idea',
      id: 'bli_forged',
      revision: 99,
      events: []
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual({ text: 'Ship it', kind: 'idea' })
  })

  it('rejects a transition to an unknown state and an empty update patch', () => {
    expect(BacklogTransitionParams.safeParse({ id: ITEM_ID, to: 'archived' }).success).toBe(false)
    expect(BacklogTransitionParams.safeParse({ id: ITEM_ID, to: 'done' }).success).toBe(true)
    expect(BacklogUpdateParams.safeParse({ id: ITEM_ID, patch: {} }).success).toBe(false)
    const stripped = BacklogUpdateParams.safeParse({
      id: ITEM_ID,
      patch: { priority: 'low', revision: 7 },
      revision: 7
    })
    expect(stripped.success).toBe(true)
    expect(stripped.data).toEqual({ id: ITEM_ID, patch: { priority: 'low' } })
  })

  it('bounds the ingest batch and refuses NUL identity components and unknown kinds', () => {
    const ingest = (candidates: unknown[]) =>
      BacklogCandidatesIngestParams.safeParse({ candidates }).success
    expect(ingest([CANDIDATE])).toBe(true)
    expect(ingest(Array.from({ length: BACKLOG_INGEST_BATCH_MAX }, () => CANDIDATE))).toBe(true)
    expect(ingest(Array.from({ length: BACKLOG_INGEST_BATCH_MAX + 1 }, () => CANDIDATE))).toBe(
      false
    )
    expect(ingest([])).toBe(false)
    expect(ingest([{ ...CANDIDATE, fingerprint: 'f\0p' }])).toBe(false)
    expect(ingest([{ ...CANDIDATE, source: { ...CANDIDATE.source, ref: 'c\0nv' } }])).toBe(false)
    expect(ingest([{ ...CANDIDATE, source: { ...CANDIDATE.source, kind: 'email' } }])).toBe(false)
    expect(ingest([{ ...CANDIDATE, uncertainty: 0.4 }])).toBe(false)
  })

  it('validates resolve actions and merge ids', () => {
    const resolve = (params: unknown) => BacklogCandidatesResolveParams.safeParse(params).success
    expect(resolve({ action: 'accept', candidateId: CANDIDATE_ID })).toBe(true)
    expect(resolve({ action: 'merge', candidateId: CANDIDATE_ID, itemId: ITEM_ID })).toBe(true)
    expect(resolve({ action: 'merge', candidateId: CANDIDATE_ID })).toBe(false)
    expect(resolve({ action: 'archive', candidateId: CANDIDATE_ID })).toBe(false)
    expect(resolve({ action: 'dismiss', candidateId: 'blc_short' })).toBe(false)
    expect(BacklogMergeParams.safeParse(VALID_PARAMS['backlog.merge']).success).toBe(true)
    expect(BacklogMergeParams.safeParse({ survivorId: ITEM_ID, loserId: CANDIDATE_ID }).success).toBe(
      false
    )
  })
})
