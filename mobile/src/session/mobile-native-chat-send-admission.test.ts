import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  MOBILE_NATIVE_CHAT_PASTE_SETTLE_MS,
  MOBILE_NATIVE_CHAT_SUBMIT_REPEATS,
  sendMobileNativeChatMessageWithOutcome
} from './mobile-native-chat-send'

// SEND-P0 phase 13. Measured on Claude Code 2.1.311 under ConPTY (.planning/phases/13-*/13-VERIFICATION.md):
// `\x15`+body in ONE write, then `\r`, is never admitted as a turn once the body is paste-sized (>=94 chars;
// the Owner's 159-char message stayed on the input line). The same bytes with the clear as its own write are
// admitted. So the admitted shape is the contract: a body write carries no clear byte. Same shape as the
// Owner's message (Spanish, two emoji, ~140 chars), not its text.
const OWNER_MESSAGE =
  'podrías revisar si el despliegue de mañana sigue en pie? 😂😂 porque he visto que soporte cambió la ventana y nadie avisó al cliente'

type SentParams = { text: string; enter: boolean }

function acceptingClient(): RpcClient {
  return {
    sendRequest: vi.fn().mockResolvedValue({
      id: 'request',
      ok: true,
      result: { send: { accepted: true } },
      _meta: { runtimeId: 'runtime' }
    })
  } as unknown as RpcClient
}

const writes = (client: RpcClient): SentParams[] =>
  vi.mocked(client.sendRequest).mock.calls.map((call) => call[1] as SentParams)

describe('a chat send that clears the input line first', () => {
  it('never puts the clear byte in the same write as a paste-sized body', async () => {
    const client = acceptingClient()
    await sendMobileNativeChatMessageWithOutcome({
      client,
      terminal: 'term',
      text: OWNER_MESSAGE,
      clearInputFirst: true
    })
    const bodyWrite = writes(client).find((w) => w.text.includes('despliegue'))
    expect(bodyWrite?.text).toBe(OWNER_MESSAGE)
    expect(bodyWrite?.enter).toBe(true)
  })

  it('sends the clear alone, without Enter, before the body', async () => {
    const client = acceptingClient()
    await sendMobileNativeChatMessageWithOutcome({
      client,
      terminal: 'term',
      text: OWNER_MESSAGE,
      clearInputFirst: true
    })
    expect(writes(client).map((w) => [w.text, w.enter])).toEqual([
      ['\x15', false],
      [OWNER_MESSAGE, true]
    ])
  })
})

// SEND-P0b phase 17. Through a real Orca host, a typed 6-paragraph 1159-char body reached Claude Code without its
// beginning (cut mid-word); the same body as one bracketed paste arrived whole (17-VERIFICATION.md). Synthetic text.
const MULTI_PARAGRAPH = Array.from(
  { length: 6 },
  (_, i) => `Paragraph ${i + 1}: the phone asks the desktop agent a longer question 😂.`
).join('\n\n')

function clientAnswering(...accepted: boolean[]): RpcClient {
  const sendRequest = vi.fn()
  for (const ok of accepted) {
    sendRequest.mockResolvedValueOnce({
      id: 'request',
      ok: true,
      result: { send: ok ? { accepted: true } : { accepted: false, bytesWritten: 0 } },
      _meta: { runtimeId: 'runtime' }
    })
  }
  return { sendRequest } as unknown as RpcClient
}

async function sendChatTurn(
  client: RpcClient,
  extra: Partial<Parameters<typeof sendMobileNativeChatMessageWithOutcome>[0]> = {}
) {
  vi.useFakeTimers()
  try {
    const outcome = sendMobileNativeChatMessageWithOutcome({
      client,
      terminal: 'term',
      text: MULTI_PARAGRAPH,
      clearInputFirst: true,
      asAgentPrompt: true,
      ...extra
    })
    await vi.advanceTimersByTimeAsync(
      MOBILE_NATIVE_CHAT_PASTE_SETTLE_MS * (1 + MOBILE_NATIVE_CHAT_SUBMIT_REPEATS)
    )
    return await outcome
  } finally {
    vi.useRealTimers()
  }
}

describe('a composer chat turn', () => {
  it('pastes the whole body as ONE bracketed paste, then submits with Enter as its own write', async () => {
    const client = clientAnswering(true, true, true, true, true)
    expect(await sendChatTurn(client)).toBe('accepted')
    expect(writes(client).map((w) => [w.text, w.enter])).toEqual([
      ['\x15', false],
      [`\x1b[200~${MULTI_PARAGRAPH}\x1b[201~`, false],
      ['\r', false],
      ['\r', false],
      ['\r', false]
    ])
  })

  // SEND-P0b phase 19, measured on Claude Code 2.1.312 under ConPTY (19-VERIFICATION.md "Trigger"): an Enter read
  // in one batch with the paste becomes a newline and the body stays unsubmitted; one more Enter does nothing, a
  // second submits it. Spare Enters on an empty prompt add no turn.
  it('presses Enter twice more, a settle apart, so an Enter swallowed with the paste cannot park the body', async () => {
    const client = clientAnswering(true, true, true, true, true)
    vi.useFakeTimers()
    try {
      const outcome = sendMobileNativeChatMessageWithOutcome({
        client,
        terminal: 'term',
        text: MULTI_PARAGRAPH,
        clearInputFirst: true,
        asAgentPrompt: true
      })
      await vi.advanceTimersByTimeAsync(MOBILE_NATIVE_CHAT_PASTE_SETTLE_MS)
      expect(writes(client)).toHaveLength(3)
      await vi.advanceTimersByTimeAsync(MOBILE_NATIVE_CHAT_PASTE_SETTLE_MS - 1)
      expect(writes(client)).toHaveLength(3)
      await vi.advanceTimersByTimeAsync(1)
      expect(writes(client)).toHaveLength(4)
      await vi.advanceTimersByTimeAsync(MOBILE_NATIVE_CHAT_PASTE_SETTLE_MS)
      expect(writes(client)).toHaveLength(5)
      expect(await outcome).toBe('accepted')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the turn accepted when a repeat Enter is refused, and stops repeating', async () => {
    const client = clientAnswering(true, true, true, false, true)
    expect(await sendChatTurn(client)).toBe('accepted')
    expect(writes(client)).toHaveLength(4)
  })

  it('resolves the launch draft only on the first submitting write', async () => {
    const client = clientAnswering(true, true, true, true, true)
    const draft = { text: 'parked', createdAt: 1 }
    await sendChatTurn(client, { resolvedLaunchDraft: draft })
    const sent = vi
      .mocked(client.sendRequest)
      .mock.calls.map((c) => c[1] as Record<string, unknown>)
    expect(sent.map((p) => p.resolvedLaunchDraft)).toEqual([
      undefined,
      undefined,
      draft,
      undefined,
      undefined
    ])
  })

  it('a refused paste is a refusal and never sends Enter', async () => {
    const client = clientAnswering(true, false)
    expect(await sendChatTurn(client)).toBe('rejected')
    expect(writes(client)).toHaveLength(2)
  })

  it('a failed Enter after an accepted paste is unknown, never rejected (a retry would paste twice)', async () => {
    const client = clientAnswering(true, true, false)
    expect(await sendChatTurn(client)).toBe('unknown')
  })
})
