import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '../transport/types'
import {
  mobileNativeChatRefusalMessage,
  readTerminalSendRefusal,
  SEND_NOT_ACCEPTED
} from './mobile-native-chat-send-refusal'

const failure = (code: string, message: string): RpcResponse => ({
  id: 'r',
  ok: false,
  error: { code, message },
  _meta: { runtimeId: 'runtime' }
})

describe('a refused phone send names why', () => {
  it('reads a passthrough code and a code carried as a runtime_error message', () => {
    expect(readTerminalSendRefusal(failure('terminal_handle_stale', 'terminal_handle_stale'))).toBe(
      'terminal_handle_stale'
    )
    expect(
      readTerminalSendRefusal(failure('runtime_error', 'mobile_input_floor_unavailable'))
    ).toBe('mobile_input_floor_unavailable')
    expect(
      readTerminalSendRefusal(failure('method_not_found', 'Unknown method: terminal.send'))
    ).toBe('method_not_found')
  })

  it('treats an ok reply without accepted:true as a refusal, not a send', () => {
    expect(
      readTerminalSendRefusal({
        id: 'r',
        ok: true,
        result: { send: { accepted: false } },
        _meta: { runtimeId: 'runtime' }
      })
    ).toBe(SEND_NOT_ACCEPTED)
  })

  it('gives each known refusal its own recovery and never words one as sent', () => {
    const codes = [
      'terminal_handle_stale',
      'terminal_not_writable',
      'mobile_input_floor_unavailable',
      'method_not_found',
      'send_budget_exhausted'
    ]
    const messages = codes.map(mobileNativeChatRefusalMessage)
    expect(new Set(messages).size).toBe(codes.length)
    for (const message of messages) {
      expect(message).toMatch(/^Not sent: /)
    }
  })

  it('falls back to the plain failure for a code it does not know', () => {
    expect(mobileNativeChatRefusalMessage('something_new')).toBe('Message not sent')
    expect(mobileNativeChatRefusalMessage(null)).toBe('Message not sent')
  })
})
