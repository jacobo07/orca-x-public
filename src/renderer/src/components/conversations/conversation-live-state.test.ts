import { describe, expect, it } from 'vitest'

import type { ConversationTurnOutcome } from '../../../../shared/conversation-turn'

import {
  applyConversationLiveEvent,
  applyConversationTurnOutcome,
  beginConversationTurn,
  EMPTY_CONVERSATION_LIVE_STATE,
  noticeForTurnOutcome
} from './conversation-live-state'

describe('conversation live state — streaming', () => {
  it('accumulates deltas for the message being written', () => {
    let state = beginConversationTurn(EMPTY_CONVERSATION_LIVE_STATE)
    state = applyConversationLiveEvent(state, {
      kind: 'assistant-delta',
      turnId: 't1',
      itemId: 'i1',
      text: 'Hel'
    })
    state = applyConversationLiveEvent(state, {
      kind: 'assistant-delta',
      turnId: 't1',
      itemId: 'i1',
      text: 'lo'
    })

    expect(state.streamingByItemId).toEqual({ i1: 'Hello' })
    expect(state.turnState).toBe('working')
  })

  it('drops the stream when the message settles, so nothing is shown twice', () => {
    let state = beginConversationTurn(EMPTY_CONVERSATION_LIVE_STATE)
    state = applyConversationLiveEvent(state, {
      kind: 'assistant-delta',
      turnId: 't1',
      itemId: 'i1',
      text: 'Hello'
    })
    state = applyConversationLiveEvent(state, {
      kind: 'message-completed',
      turnId: 't1',
      itemId: 'i1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Hello' }]
    })

    // The settled message now comes from the durable record; keeping the stream would render it
    // once live and once stored.
    expect(state.streamingByItemId).toEqual({})
  })

  it('keeps two concurrent items apart', () => {
    let state = beginConversationTurn(EMPTY_CONVERSATION_LIVE_STATE)
    state = applyConversationLiveEvent(state, {
      kind: 'assistant-delta',
      turnId: 't1',
      itemId: 'i1',
      text: 'one'
    })
    state = applyConversationLiveEvent(state, {
      kind: 'assistant-delta',
      turnId: 't1',
      itemId: 'i2',
      text: 'two'
    })

    expect(state.streamingByItemId).toEqual({ i1: 'one', i2: 'two' })
  })

  it('clears everything when the turn completes', () => {
    let state = beginConversationTurn(EMPTY_CONVERSATION_LIVE_STATE)
    state = applyConversationLiveEvent(state, {
      kind: 'assistant-delta',
      turnId: 't1',
      itemId: 'i1',
      text: 'partial'
    })
    state = applyConversationLiveEvent(state, { kind: 'turn-completed', turnId: 't1' })

    expect(state).toMatchObject({ turnState: 'idle', streamingByItemId: {}, notice: null })
  })
})

describe('conversation live state — honest endings', () => {
  it('reports an interrupted turn rather than leaving it looking finished', () => {
    let state = beginConversationTurn(EMPTY_CONVERSATION_LIVE_STATE)
    state = applyConversationLiveEvent(state, {
      kind: 'turn-ended',
      turnId: 't1',
      state: 'interrupted',
      reason: 'the provider stopped responding'
    })

    expect(state.turnState).toBe('idle')
    // `interrupted` and `failed` stay apart: one is the provider stopping, the other is it
    // breaking, and they call for different things from the person reading it.
    expect(state.notice?.kind).toBe('interrupted')
    expect(state.notice?.userMessageKept).toBe(true)
    expect(state.notice?.detail).toBe('the provider stopped responding')
  })

  it('keeps a failed turn distinct from an interrupted one', () => {
    let state = beginConversationTurn(EMPTY_CONVERSATION_LIVE_STATE)
    state = applyConversationLiveEvent(state, {
      kind: 'turn-ended',
      turnId: 't1',
      state: 'failed',
      reason: 'provider crashed'
    })
    expect(state.notice?.kind).toBe('failed')
  })

  it('says what Orca did when the agent asks to run a command', () => {
    let state = beginConversationTurn(EMPTY_CONVERSATION_LIVE_STATE)
    state = applyConversationLiveEvent(state, {
      kind: 'approval-requested',
      approvalId: 'a1',
      method: 'item/commandExecution/requestApproval',
      summary: 'echo hi'
    })

    // Leaving this silent would show a turn that appears stuck for a reason nobody can see.
    expect(state.notice?.kind).toBe('approval-declined')
    expect(state.notice?.detail).toBe('echo hi')
  })

  it('surfaces a provider status without turning it into a message', () => {
    let state = beginConversationTurn(EMPTY_CONVERSATION_LIVE_STATE)
    state = applyConversationLiveEvent(state, {
      kind: 'provider-status',
      status: 'running',
      detail: 'waitingOnApproval'
    })

    expect(state.status).toBe('waitingOnApproval')
    expect(state.notice).toBeNull()
  })
})

describe('conversation live state — every refusal names what to do', () => {
  const cases: { outcome: ConversationTurnOutcome; kind: string; kept: boolean }[] = [
    { outcome: { outcome: 'busy', activeTurnId: 't1' }, kind: 'busy', kept: false },
    {
      outcome: { outcome: 'auth-required', detail: 'codex credential is missing' },
      kind: 'auth-required',
      kept: true
    },
    { outcome: { outcome: 'not-durable', reason: 'superseded' }, kind: 'not-durable', kept: true },
    { outcome: { outcome: 'failed', turnId: 't1', reason: 'died' }, kind: 'failed', kept: true },
    { outcome: { outcome: 'conversation-absent' }, kind: 'absent', kept: false }
  ]

  for (const testCase of cases) {
    it(`classifies ${testCase.outcome.outcome} distinctly`, () => {
      const notice = noticeForTurnOutcome(testCase.outcome)
      expect(notice?.kind).toBe(testCase.kind)
      expect(notice?.userMessageKept).toBe(testCase.kept)
    })
  }

  it('says nothing on success', () => {
    expect(
      noticeForTurnOutcome({ outcome: 'completed', turnId: 't1', providerSessionId: 'th1' })
    ).toBeNull()
  })

  it('gives every outcome a DIFFERENT kind, so one cannot stand in for another', () => {
    const kinds = cases.map((testCase) => noticeForTurnOutcome(testCase.outcome)?.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('passes the provider’s own words through instead of inventing friendlier ones', () => {
    // The detail is evidence. A prettier paraphrase would hide what actually happened.
    expect(noticeForTurnOutcome({ outcome: 'not-durable', reason: 'superseded' })?.detail).toBe(
      'superseded'
    )
    expect(
      noticeForTurnOutcome({ outcome: 'auth-required', detail: 'codex credential is missing' })
        ?.detail
    ).toBe('codex credential is missing')
  })

  it('clears the stream when a refusal ends the turn', () => {
    let state = beginConversationTurn(EMPTY_CONVERSATION_LIVE_STATE)
    state = applyConversationLiveEvent(state, {
      kind: 'assistant-delta',
      turnId: 't1',
      itemId: 'i1',
      text: 'half a sen'
    })
    state = applyConversationTurnOutcome(state, { outcome: 'failed', turnId: 't1', reason: 'died' })

    // A half-sentence must not sit on screen looking like an answer.
    expect(state.streamingByItemId).toEqual({})
    expect(state.turnState).toBe('idle')
  })
})
