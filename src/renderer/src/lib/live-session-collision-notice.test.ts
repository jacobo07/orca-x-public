import { afterEach, describe, expect, it, vi } from 'vitest'

const { warningMock, state } = vi.hoisted(() => ({
  warningMock: vi.fn(),
  state: { tabsByWorktree: { 'wt-1': [{ id: 'tab-here' }] } as Record<string, { id: string }[]> }
}))

vi.mock('sonner', () => ({ toast: { warning: warningMock } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))

import {
  createLiveSessionCollisionNoticeHandler,
  subscribeLiveSessionCollisionNotices
} from './live-session-collision-notice'

const LEAF = '11111111-1111-4111-8111-111111111111'
const HERE = `tab-here:${LEAF}`
const ELSEWHERE = `tab-other:${LEAF}`

function handler(ownedTabs: string[]) {
  const warn = vi.fn()
  const handle = createLiveSessionCollisionNoticeHandler({
    ownsTab: (tabId) => ownedTabs.includes(tabId),
    warn
  })
  return { handle, warn }
}

afterEach(() => {
  warningMock.mockReset()
})

describe('createLiveSessionCollisionNoticeHandler', () => {
  it('tells the window holding the pane, in after-the-fact terms', () => {
    const { handle, warn } = handler(['tab-here'])

    handle({ paneKey: HERE, kind: 'live-elsewhere', liveElsewhere: [ELSEWHERE] })

    expect(warn).toHaveBeenCalledTimes(1)
    const [title, description] = warn.mock.calls[0]
    expect(title).toBe('This session is also open in another pane')
    expect(description).toContain('It was resumed here while it was already running.')
    // Why: the provider already loaded the session; nothing here may claim it was stopped.
    expect(`${title} ${description}`).not.toMatch(/prevent|blocked|not opened/i)
  })

  it('counts several other owners', () => {
    const { handle, warn } = handler(['tab-here'])

    handle({
      paneKey: HERE,
      kind: 'multiple-live-owners',
      liveElsewhere: [ELSEWHERE, `tab-third:${LEAF}`]
    })

    expect(warn.mock.calls[0][0]).toBe('This session is also open in 2 other panes')
  })

  it('stays silent in a window that does not hold the pane', () => {
    const { handle, warn } = handler(['tab-other'])

    handle({ paneKey: HERE, kind: 'live-elsewhere', liveElsewhere: [ELSEWHERE] })

    expect(warn).not.toHaveBeenCalled()
  })

  it.each([
    ['null', null],
    ['legacy pane key', { paneKey: 'tab-here:3', kind: 'live-elsewhere', liveElsewhere: [] }],
    ['unknown kind', { paneKey: HERE, kind: 'unknown', liveElsewhere: [] }],
    ['missing owners', { paneKey: HERE, kind: 'live-elsewhere' }]
  ])('ignores a malformed notice: %s', (_name, value) => {
    const { handle, warn } = handler(['tab-here'])

    handle(value)

    expect(warn).not.toHaveBeenCalled()
  })
})

describe('subscribeLiveSessionCollisionNotices', () => {
  it('shows a warning toast for a pane in this window and unsubscribes cleanly', () => {
    let listener: ((notice: unknown) => void) | null = null
    const unsubscribe = vi.fn()
    vi.stubGlobal('window', {
      api: {
        agentStatus: {
          onLiveCollision: (callback: (notice: unknown) => void) => {
            listener = callback
            return unsubscribe
          }
        }
      }
    })

    const stop = subscribeLiveSessionCollisionNotices()
    listener!({ paneKey: HERE, kind: 'live-elsewhere', liveElsewhere: [ELSEWHERE] })
    listener!({ paneKey: `tab-foreign:${LEAF}`, kind: 'live-elsewhere', liveElsewhere: [HERE] })
    stop()

    expect(warningMock).toHaveBeenCalledTimes(1)
    expect(warningMock.mock.calls[0][0]).toBe('This session is also open in another pane')
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })
})
