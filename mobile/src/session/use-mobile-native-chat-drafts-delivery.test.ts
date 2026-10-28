import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MOBILE_NATIVE_CHAT_ADMISSION_BOUND_MS } from './mobile-native-chat-delivery-evidence'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'

type DraftState = ReturnType<typeof useMobileNativeChatDrafts>

const userTurn = (id: string, text: string): NativeChatMessage => ({
  id,
  role: 'user',
  blocks: [{ type: 'text', text }],
  timestamp: null,
  source: 'transcript'
})

// SEND-P0: the phone showed a sent bubble for a message that sat unsubmitted on the agent's input line.
describe('a pending chat bubble never outruns its evidence', () => {
  let renderer: ReactTestRenderer | null = null
  let state: DraftState | null = null

  function Harness({ messages = [] }: { messages?: NativeChatMessage[] }): null {
    state = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId: 'tab',
      sessionId: 'session',
      messages
    })
    return null
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    await act(async () => {
      renderer = create(createElement(Harness, {}))
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
    vi.useRealTimers()
  })

  function acceptPing(): void {
    const origin = state?.captureSendOrigin('ping')
    act(() => {
      if (origin) {
        state?.acceptSend(origin, 'ping')
      }
    })
  }

  it('shows written, not delivered, while the transcript has no echo', () => {
    acceptPing()
    expect(state?.pending.map((item) => item.delivery)).toEqual(['written'])
  })

  it('turns unconfirmed once the admission bound passes without an echo', () => {
    acceptPing()
    act(() => vi.advanceTimersByTime(MOBILE_NATIVE_CHAT_ADMISSION_BOUND_MS - 1))
    expect(state?.pending.map((item) => item.delivery)).toEqual(['written'])
    act(() => vi.advanceTimersByTime(1))
    expect(state?.pending.map((item) => item.delivery)).toEqual(['unconfirmed'])
  })

  it('leaves the list once the echo lands, and the bound cannot bring it back', async () => {
    acceptPing()
    await act(async () =>
      renderer?.update(createElement(Harness, { messages: [userTurn('m1', 'ping')] }))
    )
    expect(state?.pending).toEqual([])
    act(() => vi.advanceTimersByTime(MOBILE_NATIVE_CHAT_ADMISSION_BOUND_MS))
    expect(state?.pending).toEqual([])
  })

  // SEND-P0b phase 18: on the device `hola?` became a real turn, yet the phone said "Agent has not shown this
  // message". The transcript is a 40-message window whose head live frames trim, so an earlier equal turn counted at
  // send time can slide out and leave the absolute count one short forever.
  const assistantTurn = (id: string): NativeChatMessage => ({
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: 'hi' }],
    timestamp: null,
    source: 'transcript'
  })

  async function showMessages(messages: NativeChatMessage[]): Promise<void> {
    await act(async () => renderer?.update(createElement(Harness, { messages })))
  }

  function accept(text: string): void {
    const origin = state?.captureSendOrigin(text)
    act(() => {
      if (origin) {
        state?.acceptSend(origin, text)
      }
    })
  }

  it('retires the bubble when its echo lands after an earlier equal turn slid out of the window', async () => {
    await showMessages([userTurn('m1', 'hola?'), assistantTurn('m2')])
    accept('hola?')
    // The head (m1) is trimmed as the new turn and its reply arrive.
    await showMessages([assistantTurn('m2'), userTurn('m3', 'hola?'), assistantTurn('m4')])
    expect(state?.pending).toEqual([])
  })

  it('does not take an earlier equal turn that pagination brings back as the echo', async () => {
    await showMessages([assistantTurn('m2')])
    accept('hola?')
    // Older history is paged in; the only `hola?` sits BEFORE the send's tail.
    await showMessages([userTurn('m1', 'hola?'), assistantTurn('m2')])
    expect(state?.pending.map((item) => item.delivery)).toEqual(['written'])
  })

  it('stops its timer when the screen unmounts', () => {
    acceptPing()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    act(() => renderer?.unmount())
    renderer = null
    expect(vi.getTimerCount()).toBe(0)
  })
})
