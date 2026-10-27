import type { RpcResponse } from '../transport/types'

/** Refusals the phone raises itself, before or instead of a host answer. */
export const SEND_BUDGET_EXHAUSTED = 'send_budget_exhausted'
export const SEND_NOT_ACCEPTED = 'send_not_accepted'

/** The host's own refusal code for a terminal.send that did not write. The host throws a bare
 *  `Error(code)`; codes off its passthrough list arrive as `runtime_error` with the code as message. */
export function readTerminalSendRefusal(response: RpcResponse): string {
  if (response.ok) {
    return SEND_NOT_ACCEPTED
  }
  const { code, message } = response.error
  if (code && code !== 'runtime_error') {
    return code
  }
  return message || code || 'runtime_error'
}

const TERMINAL_GONE = new Set([
  'terminal_handle_stale',
  'terminal_not_found',
  'terminal_gone',
  'terminal_exited'
])
const TERMINAL_NOT_WRITABLE = new Set(['terminal_not_writable', 'terminal_guard_not_writable'])

/** Names the narrowest recovery. An unknown code falls back to the plain failure: never success. */
export function mobileNativeChatRefusalMessage(refusal: string | null): string {
  if (refusal === null) {
    return 'Message not sent'
  }
  if (TERMINAL_GONE.has(refusal)) {
    return 'Not sent: this terminal closed on the desktop'
  }
  if (TERMINAL_NOT_WRITABLE.has(refusal)) {
    return 'Not sent: the desktop is not taking input in this terminal'
  }
  if (refusal === 'mobile_input_floor_unavailable') {
    return 'Not sent: the phone lost control of this terminal. Reopen it, then send again'
  }
  if (refusal === 'method_not_found') {
    return 'Not sent: Orca X on the desktop is too old for this. Update it'
  }
  if (refusal === SEND_BUDGET_EXHAUSTED) {
    return 'Not sent: the desktop took too long to answer'
  }
  return 'Message not sent'
}
