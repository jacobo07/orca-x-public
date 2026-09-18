import { describe, expect, it, vi } from 'vitest'
import type { LiveAgentSessionPresence } from './live-agent-session-presence'
import {
  createLiveSessionCollisionDetector,
  type LiveSessionCollisionEvent
} from './live-session-collision-detector'

function presence(overrides: Partial<LiveAgentSessionPresence> = {}): LiveAgentSessionPresence {
  return {
    kind: 'live-elsewhere',
    liveHere: false,
    liveElsewhere: ['tab-a:leaf'],
    stale: [],
    unknown: [],
    ...overrides
  }
}

function event(overrides: Partial<LiveSessionCollisionEvent> = {}): LiveSessionCollisionEvent {
  return {
    paneKey: 'tab-b:leaf',
    worktreeId: 'worktree-1',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'session-a' },
    ...overrides
  }
}

describe('createLiveSessionCollisionDetector', () => {
  it('notifies when a pane starts reporting a session that is live in another pane', async () => {
    const notify = vi.fn()
    const readPresence = vi.fn(async () => presence())
    const detector = createLiveSessionCollisionDetector({ readPresence, notify })

    await detector.onEvent(event())

    expect(readPresence).toHaveBeenCalledWith({
      subject: {
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'session-a' },
        worktreeId: 'worktree-1'
      },
      requestingPaneKey: 'tab-b:leaf'
    })
    expect(notify).toHaveBeenCalledWith({
      paneKey: 'tab-b:leaf',
      kind: 'live-elsewhere',
      liveElsewhere: ['tab-a:leaf']
    })
  })

  it('checks once per session transition, not on every hook event', async () => {
    const readPresence = vi.fn(async () => presence())
    const detector = createLiveSessionCollisionDetector({ readPresence, notify: vi.fn() })

    await detector.onEvent(event())
    await detector.onEvent(event())
    await detector.onEvent(event({ providerSession: { key: 'session_id', id: 'session-b' } }))

    expect(readPresence).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['a replayed event', { isReplay: true }],
    ['a row restored from disk', { restoredUnconfirmed: true as const }],
    ['no provider session', { providerSession: undefined }],
    ['no worktree', { worktreeId: undefined }],
    ['a non-resumable agent', { agentType: 'not-an-agent' }]
  ])('ignores %s', async (_name, overrides) => {
    const readPresence = vi.fn(async () => presence())
    const detector = createLiveSessionCollisionDetector({ readPresence, notify: vi.fn() })

    await detector.onEvent(event(overrides))

    expect(readPresence).not.toHaveBeenCalled()
  })

  it.each([
    ['no live owner', presence({ kind: 'no-live-owner', liveElsewhere: [] })],
    ['uncertainty', presence({ kind: 'unknown', liveElsewhere: [], unknown: ['tab-a:leaf'] })],
    ['live only here', presence({ kind: 'live-here', liveHere: true, liveElsewhere: [] })]
  ])('stays silent for %s', async (_name, answer) => {
    const notify = vi.fn()
    const detector = createLiveSessionCollisionDetector({
      readPresence: async () => answer,
      notify
    })

    await detector.onEvent(event())

    expect(notify).not.toHaveBeenCalled()
  })

  it('reports every other owner', async () => {
    const notify = vi.fn()
    const detector = createLiveSessionCollisionDetector({
      readPresence: async () =>
        presence({ kind: 'multiple-live-owners', liveElsewhere: ['tab-a:leaf', 'tab-c:leaf'] }),
      notify
    })

    await detector.onEvent(event())

    expect(notify).toHaveBeenCalledWith({
      paneKey: 'tab-b:leaf',
      kind: 'multiple-live-owners',
      liveElsewhere: ['tab-a:leaf', 'tab-c:leaf']
    })
  })

  it('drops a verdict about a session the pane already left', async () => {
    const notify = vi.fn()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const detector = createLiveSessionCollisionDetector({
      readPresence: async ({ subject }) => {
        if (subject.providerSession.id === 'session-a') {
          await gate
          return presence()
        }
        return presence({ kind: 'no-live-owner', liveElsewhere: [] })
      },
      notify
    })

    const first = detector.onEvent(event())
    await detector.onEvent(event({ providerSession: { key: 'session_id', id: 'session-b' } }))
    release()
    await first

    expect(notify).not.toHaveBeenCalled()
  })

  it('checks again after the pane is torn down and the session returns', async () => {
    const readPresence = vi.fn(async () => presence())
    const detector = createLiveSessionCollisionDetector({ readPresence, notify: vi.fn() })

    await detector.onEvent(event())
    detector.forgetPane('tab-b:leaf')
    await detector.onEvent(event())

    expect(readPresence).toHaveBeenCalledTimes(2)
  })

  it('treats a failed read as no notice and still allows a later check', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const notify = vi.fn()
    const readPresence = vi
      .fn<() => Promise<LiveAgentSessionPresence>>()
      .mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValue(presence())
    const detector = createLiveSessionCollisionDetector({ readPresence, notify })

    await detector.onEvent(event())
    await detector.onEvent(event())

    expect(notify).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
