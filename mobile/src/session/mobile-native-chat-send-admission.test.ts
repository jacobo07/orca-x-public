import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { sendMobileNativeChatMessageWithOutcome } from './mobile-native-chat-send'

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
