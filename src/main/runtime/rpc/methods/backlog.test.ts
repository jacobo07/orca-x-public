import { describe, expect, it } from 'vitest'

import { BACKLOG_TEXT_MAX } from '../../../../shared/backlog-rpc-limits'
import type { RpcContext } from '../core'
import { BACKLOG_METHODS } from './backlog'
import { BacklogCaptureParams } from './backlog-params'

// Ratchet: later plans extend this list when they add methods.
const NAMES = ['backlog.capture', 'backlog.get']

const VALID_PARAMS: Record<string, unknown> = {
  'backlog.capture': { text: 'Ship it', kind: 'engineering' },
  'backlog.get': { id: 'bli_00000000-0000-4000-8000-000000000000' }
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
  })

  it('answers capability_unsupported on a host with no backlog host (fails closed)', async () => {
    for (const entry of BACKLOG_METHODS) {
      const method = entry as unknown as {
        handler: (params: unknown, ctx: RpcContext) => Promise<unknown>
      }
      await expect(
        method.handler(VALID_PARAMS[entry.name], ctxWithoutHost()),
        entry.name
      ).rejects.toMatchObject({ code: 'capability_unsupported' })
    }
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
})
