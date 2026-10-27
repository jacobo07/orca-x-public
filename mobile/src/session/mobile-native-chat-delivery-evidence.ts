// A pending chat bubble exists only after the host accepted the PTY write, and it leaves the list
// when the transcript echo replaces it. So "delivered" is the transcript message itself; while
// pending, the bubble says what is actually known. A PTY write receipt is not a turn: a paste-sized
// body once sat unsubmitted on Claude Code's input line while the phone showed it as sent (SEND-P0).
export type MobileNativeChatPendingDelivery = 'written' | 'unconfirmed'

/** How long a written bubble waits for its transcript echo before it says so. Matches the
 *  ack-lost hold, so both kinds of uncertainty surface on the same clock. */
export const MOBILE_NATIVE_CHAT_ADMISSION_BOUND_MS = 20_000

export function mobileNativeChatDeliveryCaption(delivery: MobileNativeChatPendingDelivery): string {
  return delivery === 'written'
    ? 'Sent to the terminal · waiting for the agent'
    : 'Agent has not shown this message · check the desktop before resending'
}
