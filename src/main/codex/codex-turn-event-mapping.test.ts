import { describe, expect, it } from 'vitest'

import { mapCodexNotification } from './codex-turn-event-mapping'

// Payload shapes taken from a real run against codex-cli 0.153.4 (2026-09-21): a turn that asked
// to run `echo`, had its approval declined by Orca, and completed. Field names not present in that
// trace were checked against the installed schema rather than assumed.

describe('mapCodexNotification', () => {
  it('reads the turn id out of turn/started', () => {
    expect(
      mapCodexNotification({
        method: 'turn/started',
        params: {
          threadId: '01a0c157-cb43-7f51-a7b4-d56ea2823727',
          turn: { id: '01a0c157-d7e5-7771-b43d-f33487693ec8', items: [], status: 'inProgress' }
        }
      })
    ).toEqual({ kind: 'turn-started', turnId: '01a0c157-d7e5-7771-b43d-f33487693ec8' })
  })

  it('carries an assistant delta with the item it belongs to', () => {
    expect(
      mapCodexNotification({
        method: 'item/agentMessage/delta',
        params: { threadId: 't', turnId: 'turn-1', itemId: 'msg_067', delta: ' run' }
      })
    ).toEqual({ kind: 'assistant-delta', turnId: 'turn-1', itemId: 'msg_067', text: ' run' })
  })

  it('turns a completed agent message into assistant blocks', () => {
    expect(
      mapCodexNotification({
        method: 'item/completed',
        params: {
          threadId: 't',
          item: {
            type: 'agentMessage',
            id: 'msg_067',
            text: 'The command didn’t run because approval was rejected.',
            phase: 'final_answer'
          }
        }
      })
    ).toEqual({
      kind: 'message-completed',
      turnId: null,
      itemId: 'msg_067',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'The command didn’t run because approval was rejected.' }]
    })
  })

  it('reads a user message out of its content array, not a flat text field', () => {
    const event = mapCodexNotification({
      method: 'item/completed',
      params: {
        item: {
          type: 'userMessage',
          id: 'u1',
          content: [{ type: 'text', text: 'Run the shell command' }]
        }
      }
    })

    expect(event).toMatchObject({
      role: 'user',
      blocks: [{ type: 'text', text: 'Run the shell command' }]
    })
  })

  it('records a declined command as a tool result that is an error', () => {
    // The whole point of the declined path: it must not read as a command that ran and produced
    // nothing.
    const event = mapCodexNotification({
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          id: 'exec-8239',
          command: 'powershell -c echo orca-approval-probe',
          cwd: 'C:\\tmp',
          commandActions: [],
          status: 'declined',
          aggregatedOutput: ''
        }
      }
    })

    expect(event).toMatchObject({
      role: 'tool',
      blocks: [
        {
          type: 'tool-call',
          name: 'commandExecution',
          input: 'powershell -c echo orca-approval-probe'
        },
        { type: 'tool-result', output: '', isError: true }
      ]
    })
  })

  it('CONTROL: a completed command is not an error', () => {
    // Without this, `isError: true` unconditionally would pass the case above.
    const event = mapCodexNotification({
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          id: 'exec-1',
          command: 'echo hi',
          cwd: '/tmp',
          commandActions: [],
          status: 'completed',
          aggregatedOutput: 'hi\n'
        }
      }
    })

    expect(event).toMatchObject({
      blocks: [expect.anything(), { type: 'tool-result', output: 'hi\n', isError: false }]
    })
  })

  it('surfaces waitingOnApproval as a provider status', () => {
    expect(
      mapCodexNotification({
        method: 'thread/status/changed',
        params: { threadId: 't', status: { type: 'active', activeFlags: ['waitingOnApproval'] } }
      })
    ).toEqual({ kind: 'provider-status', status: 'active', detail: 'waitingOnApproval' })
  })

  it.each([
    'remoteControl/status/changed',
    'mcpServer/startupStatus/updated',
    'hook/started',
    'thread/tokenUsage/updated',
    'account/rateLimits/updated',
    'serverRequest/resolved',
    'something/nobodyHasSeen'
  ])('leaves %s unmapped rather than inventing meaning for it', (method) => {
    // All but the last were observed in the real trace. None of them is product content, and a
    // mapping that guessed would put provider bookkeeping into a user's conversation.
    expect(mapCodexNotification({ method, params: {} })).toEqual({ kind: 'unmapped', method })
  })

  it('refuses a well-named notification whose payload is missing its identity', () => {
    expect(mapCodexNotification({ method: 'turn/started', params: {} })).toEqual({
      kind: 'unmapped',
      method: 'turn/started'
    })
  })
})

// Verbatim from codex-cli 0.155.1 on GEX44 (2026-09-24): a turn the provider refused on a usage
// limit. It sends `error`, then completes the turn with `status: "failed"`. Before this was read, a
// real-ssh rung reported that turn to the user as `completed`.
const LIMIT = {
  message:
    'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 27th, 2026 7:54 PM.',
  codexErrorInfo: 'usageLimitExceeded',
  additionalDetails: null,
  misalignment: null
}
const TURN = '01a0d3e0-c1f7-72c0-bf7b-a37f5e5f1214'

describe('mapCodexNotification — a turn the provider did not answer', () => {
  it('ends the turn on a final error, in the provider’s own words', () => {
    expect(
      mapCodexNotification({
        method: 'error',
        params: { error: LIMIT, willRetry: false, threadId: 'thread-1', turnId: TURN }
      })
    ).toEqual({ kind: 'turn-ended', turnId: TURN, state: 'failed', reason: LIMIT.message })
  })

  it('does not end the turn on an error the provider is retrying', () => {
    expect(
      mapCodexNotification({
        method: 'error',
        params: { error: LIMIT, willRetry: true, threadId: 'thread-1', turnId: TURN }
      })
    ).toEqual({ kind: 'provider-status', status: 'retrying', detail: LIMIT.message })
  })

  it('reads a completed turn with a failed status as ended, never as answered', () => {
    expect(
      mapCodexNotification({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: TURN, items: [], status: 'failed', error: LIMIT, durationMs: 2519 }
        }
      })
    ).toEqual({ kind: 'turn-ended', turnId: TURN, state: 'failed', reason: LIMIT.message })
  })

  it('keeps an interrupted turn apart from a failed one, and a completed one as completed', () => {
    expect(
      mapCodexNotification({
        method: 'turn/completed',
        params: { turn: { id: TURN, status: 'interrupted', error: null } }
      })
    ).toMatchObject({ kind: 'turn-ended', state: 'interrupted' })
    expect(
      mapCodexNotification({
        method: 'turn/completed',
        params: { turn: { id: TURN, status: 'completed', error: null } }
      })
    ).toEqual({ kind: 'turn-completed', turnId: TURN })
  })
})
