import { describe, expect, it, vi } from 'vitest'
import type {
  LiveAgentSessionPresenceRequest,
  LiveAgentSessionPresenceResponse
} from '../../../shared/live-agent-session-presence-types'
import type {
  ConfirmationDialogContextValue,
  ConfirmationDialogOptions
} from '@/components/confirmation-dialog-context'
import { gateLiveSessionMaterialization } from './live-session-collision-gate'

function confirmReturning(result: boolean) {
  return vi.fn(async (_options: ConfirmationDialogOptions) => result)
}

const request: LiveAgentSessionPresenceRequest = {
  worktreeId: 'worktree-1',
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'session-a' }
}

function answer(
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

const clear = answer({ kind: 'no-live-owner', liveElsewhere: [], ownersRevision: '' })

function reads(...answers: LiveAgentSessionPresenceResponse[]) {
  const queue = [...answers]
  return vi.fn(async () => {
    const next = queue.shift()
    if (!next) {
      throw new Error('unexpected extra presence read')
    }
    return next
  })
}

describe('gateLiveSessionMaterialization', () => {
  it('proceeds without asking when nothing owns the session', async () => {
    const confirm = vi.fn()

    const outcome = await gateLiveSessionMaterialization({
      request,
      readPresence: reads(clear),
      confirm
    })

    expect(outcome).toBe('proceed')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('proceeds without asking when the only owner is the requesting pane', async () => {
    const confirm = vi.fn()

    const outcome = await gateLiveSessionMaterialization({
      request,
      readPresence: reads(answer({ kind: 'live-here', liveElsewhere: [], ownersRevision: '' })),
      confirm
    })

    expect(outcome).toBe('proceed')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('asks with the collision copy and stops on Back', async () => {
    const confirm = confirmReturning(false)
    const readPresence = reads(answer())

    const outcome = await gateLiveSessionMaterialization({ request, readPresence, confirm })

    expect(outcome).toBe('cancelled')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toMatchObject({
      title: 'This session is already open',
      cancelLabel: 'Back',
      confirmLabel: 'Continue'
    })
    expect(confirm.mock.calls[0][0].description).toContain('It is already active in another pane.')
    // Why: Back must not even look again; nothing after it may touch the session.
    expect(readPresence).toHaveBeenCalledTimes(1)
  })

  it('revalidates on Continue and proceeds when the collision still stands unchanged', async () => {
    const readPresence = reads(answer(), answer())

    const outcome = await gateLiveSessionMaterialization({
      request,
      readPresence,
      confirm: confirmReturning(true)
    })

    expect(outcome).toBe('proceed')
    expect(readPresence).toHaveBeenCalledTimes(2)
  })

  it('proceeds on Continue when the other owner went away while the dialog was open', async () => {
    const confirm = confirmReturning(true)

    const outcome = await gateLiveSessionMaterialization({
      request,
      readPresence: reads(answer(), clear),
      confirm
    })

    expect(outcome).toBe('proceed')
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('asks again when the owner changed while the dialog was open', async () => {
    const confirm = confirmReturning(true)
    const replaced = answer({ ownersRevision: 'tab-a:leaf@pty-2' })

    const outcome = await gateLiveSessionMaterialization({
      request,
      readPresence: reads(answer(), replaced, replaced),
      confirm
    })

    expect(outcome).toBe('proceed')
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('stops when the user declines the refreshed question', async () => {
    const confirm = vi
      .fn<ConfirmationDialogContextValue>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const moved = answer({ liveElsewhere: ['tab-b:leaf'], ownersRevision: 'tab-b:leaf@pty-9' })

    const outcome = await gateLiveSessionMaterialization({
      request,
      readPresence: reads(answer(), moved),
      confirm
    })

    expect(outcome).toBe('cancelled')
  })

  it('gives up rather than asking forever while owners keep changing', async () => {
    const confirm = confirmReturning(true)
    const revisions = ['r1', 'r2', 'r3', 'r4', 'r5'].map((ownersRevision) =>
      answer({ ownersRevision })
    )

    const outcome = await gateLiveSessionMaterialization({
      request,
      readPresence: reads(...revisions),
      confirm
    })

    expect(outcome).toBe('cancelled')
  })

  it('uses its own copy for uncertainty and never the "already open" title', async () => {
    const confirm = confirmReturning(false)

    await gateLiveSessionMaterialization({
      request,
      readPresence: reads(answer({ kind: 'unknown', liveElsewhere: [], ownersRevision: '' })),
      confirm
    })

    expect(confirm.mock.calls[0][0].title).toBe('This session may already be open')
    expect(confirm.mock.calls[0][0].title).not.toBe('This session is already open')
  })

  it('counts the owners when there are several', async () => {
    const confirm = confirmReturning(false)

    await gateLiveSessionMaterialization({
      request,
      readPresence: reads(
        answer({
          kind: 'multiple-live-owners',
          liveElsewhere: ['tab-a:leaf', 'tab-c:leaf'],
          ownersRevision: 'x'
        })
      ),
      confirm
    })

    expect(confirm.mock.calls[0][0].description).toContain('It is already active in 2 other panes.')
  })

  it('treats a failed read as uncertainty, not as a free path', async () => {
    const confirm = confirmReturning(false)
    const readPresence = vi.fn(async () => {
      throw new Error('ipc unavailable')
    })

    const outcome = await gateLiveSessionMaterialization({ request, readPresence, confirm })

    expect(outcome).toBe('cancelled')
    expect(confirm.mock.calls[0][0].title).toBe('This session may already be open')
  })

  it('refuses instead of proceeding when there is no surface to ask on', async () => {
    const outcome = await gateLiveSessionMaterialization({
      request,
      readPresence: reads(answer()),
      confirm: null
    })

    expect(outcome).toBe('cancelled')
  })

  it('keeps no permission: a second attempt asks again', async () => {
    const confirm = confirmReturning(true)
    const readPresence = reads(answer(), answer(), answer(), answer())

    await gateLiveSessionMaterialization({ request, readPresence, confirm })
    await gateLiveSessionMaterialization({ request, readPresence, confirm })

    expect(confirm).toHaveBeenCalledTimes(2)
  })
})
