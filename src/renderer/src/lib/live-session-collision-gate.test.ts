import { describe, expect, it, vi } from 'vitest'
import type {
  LiveAgentSessionPresenceRequest,
  LiveAgentSessionPresenceResponse,
  LiveSessionMaterializationRequest,
  LiveSessionMaterializationResponse
} from '../../../shared/live-agent-session-presence-types'
import type {
  ConfirmationDialogContextValue,
  ConfirmationDialogOptions
} from '@/components/confirmation-dialog-context'
import {
  gateLiveSessionMaterialization,
  gateOrcaSelectedResume
} from './live-session-collision-gate'

function confirmReturning(result: boolean) {
  return vi.fn(async (_options: ConfirmationDialogOptions) => result)
}

const request: LiveAgentSessionPresenceRequest = {
  worktreeId: 'worktree-1',
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'session-a' }
}

function presence(
  overrides: Partial<LiveAgentSessionPresenceResponse> = {}
): LiveAgentSessionPresenceResponse {
  return {
    kind: 'live-elsewhere',
    liveElsewhere: ['tab-a:leaf'],
    ownersRevision: 'tab-a:leaf@pty-1',
    unknownCount: 0,
    staleCount: 0,
    ...overrides
  }
}

const blocked = (
  overrides: Partial<LiveAgentSessionPresenceResponse> = {}
): LiveSessionMaterializationResponse => ({ outcome: 'blocked', presence: presence(overrides) })
const granted: LiveSessionMaterializationResponse = {
  outcome: 'granted',
  presence: presence({ kind: 'no-live-owner', liveElsewhere: [], ownersRevision: '' })
}
const starting = blocked({
  kind: 'materializing',
  liveElsewhere: [],
  ownersRevision: 'materializing:op-x'
})

function replies(...answers: LiveSessionMaterializationResponse[]) {
  const queue = [...answers]
  return vi.fn(async (_request: LiveSessionMaterializationRequest) => {
    const next = queue.shift()
    if (!next) {
      throw new Error('unexpected extra reserve call')
    }
    return next
  })
}

function gate(
  reserve: ReturnType<typeof replies> | (() => Promise<never>),
  confirm: ConfirmationDialogContextValue | null
) {
  return gateLiveSessionMaterialization({ request, reserve, confirm, operationId: 'op-1' })
}

describe('gateLiveSessionMaterialization', () => {
  it('proceeds with its reservation without asking when main grants', async () => {
    const confirm = vi.fn()
    const reserve = replies(granted)

    const result = await gate(reserve, confirm)

    expect(result).toEqual({ outcome: 'proceed', materialization: { operationId: 'op-1' } })
    expect(confirm).not.toHaveBeenCalled()
    expect(reserve.mock.calls[0][0]).toEqual({ ...request, operationId: 'op-1' })
  })

  it('asks with the collision copy and stops on Back', async () => {
    const confirm = confirmReturning(false)
    const reserve = replies(blocked())

    const result = await gate(reserve, confirm)

    expect(result).toEqual({ outcome: 'cancelled' })
    expect(confirm.mock.calls[0][0]).toMatchObject({
      title: 'This session is already open',
      cancelLabel: 'Back',
      confirmLabel: 'Continue'
    })
    expect(confirm.mock.calls[0][0].description).toContain('It is already active in another pane.')
    // Why: Back must not even ask main again; nothing after it may touch the session.
    expect(reserve).toHaveBeenCalledTimes(1)
  })

  it('sends back exactly the collision Continue answered, under the same operation', async () => {
    const reserve = replies(blocked(), granted)

    const result = await gate(reserve, confirmReturning(true))

    expect(result.outcome).toBe('proceed')
    expect(reserve.mock.calls[1][0]).toEqual({
      ...request,
      operationId: 'op-1',
      accept: { kind: 'live-elsewhere', ownersRevision: 'tab-a:leaf@pty-1' }
    })
  })

  it('asks again when main reports a different collision after Continue', async () => {
    const confirm = confirmReturning(true)
    const replaced = blocked({ ownersRevision: 'tab-a:leaf@pty-2' })
    const reserve = replies(blocked(), replaced, granted)

    const result = await gate(reserve, confirm)

    expect(result.outcome).toBe('proceed')
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(reserve.mock.calls[2][0].accept?.ownersRevision).toBe('tab-a:leaf@pty-2')
  })

  it('stops when the user declines the refreshed question', async () => {
    const confirm = vi
      .fn<ConfirmationDialogContextValue>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const moved = blocked({ liveElsewhere: ['tab-b:leaf'], ownersRevision: 'tab-b:leaf@pty-9' })

    expect(await gate(replies(blocked(), moved), confirm)).toEqual({ outcome: 'cancelled' })
  })

  it('gives up rather than asking forever while the collision keeps changing', async () => {
    const answers = ['r1', 'r2', 'r3', 'r4'].map((ownersRevision) => blocked({ ownersRevision }))

    expect(await gate(replies(...answers), confirmReturning(true))).toEqual({
      outcome: 'cancelled'
    })
  })

  it('never says "already open" for an attempt that is only starting', async () => {
    const confirm = confirmReturning(false)

    await gate(replies(starting), confirm)

    expect(confirm.mock.calls[0][0].title).toBe('This session is already starting')
    expect(confirm.mock.calls[0][0].description).toContain('Another resume of it is still opening.')
  })

  it('uses its own copy for uncertainty', async () => {
    const confirm = confirmReturning(false)

    await gate(
      replies(blocked({ kind: 'unknown', liveElsewhere: [], ownersRevision: '' })),
      confirm
    )

    expect(confirm.mock.calls[0][0].title).toBe('This session may already be open')
  })

  it('counts the owners when there are several', async () => {
    const confirm = confirmReturning(false)

    await gate(
      replies(
        blocked({
          kind: 'multiple-live-owners',
          liveElsewhere: ['tab-a:leaf', 'tab-c:leaf'],
          ownersRevision: 'x'
        })
      ),
      confirm
    )

    expect(confirm.mock.calls[0][0].description).toContain('It is already active in 2 other panes.')
  })

  it('treats a failed call as uncertainty, not as a grant', async () => {
    const confirm = confirmReturning(false)

    const result = await gate(async () => {
      throw new Error('ipc unavailable')
    }, confirm)

    expect(result).toEqual({ outcome: 'cancelled' })
    expect(confirm.mock.calls[0][0].title).toBe('This session may already be open')
  })

  it('does not proceed when the call fails again after Continue', async () => {
    const reserve = vi.fn(async () => {
      throw new Error('ipc unavailable')
    })

    const result = await gateLiveSessionMaterialization({
      request,
      reserve,
      confirm: confirmReturning(true),
      operationId: 'op-1'
    })

    expect(result).toEqual({ outcome: 'cancelled' })
  })

  it('refuses instead of proceeding when there is no surface to ask on', async () => {
    expect(await gate(replies(blocked()), null)).toEqual({ outcome: 'cancelled' })
  })

  it('keeps no permission: a second attempt starts without an accept and asks again', async () => {
    const confirm = confirmReturning(true)
    const reserve = replies(blocked(), granted, blocked(), granted)

    await gate(reserve, confirm)
    await gate(reserve, confirm)

    expect(confirm).toHaveBeenCalledTimes(2)
    expect(reserve.mock.calls[2][0].accept).toBeUndefined()
  })
})

describe('gateOrcaSelectedResume', () => {
  // Why: without the pane key, the resuming pane's own pre-exit row reads as live elsewhere.
  it('names the pane that will hold the session', async () => {
    const reserveMaterialization = replies(granted)
    vi.stubGlobal('window', { api: { agentStatus: { reserveMaterialization } } })
    try {
      const result = await gateOrcaSelectedResume({
        ...request,
        paneKey: 'tab-1:leaf-1',
        launchesThroughRuntime: false,
        confirm: null
      })

      expect(result.outcome).toBe('proceed')
      expect(reserveMaterialization.mock.calls[0][0]).toMatchObject({
        paneKey: 'tab-1:leaf-1',
        providerSession: request.providerSession
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
