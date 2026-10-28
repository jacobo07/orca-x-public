import type { MobileNativeChatPendingDelivery } from './mobile-native-chat-delivery-evidence'

export type MobileNativeChatPendingMessage = {
  id: string
  text: string
  /** Evidence so far: the PTY write was accepted; the transcript echo has not landed. */
  delivery: MobileNativeChatPendingDelivery
  expectedOccurrence: number
  /** Which equal user turn after `baselineTailMessageId` is this send's echo (1 = the first). */
  echoOrdinalAfterTail?: number
  /** Local preview URIs carried by the send for its optimistic echo. */
  images?: string[]
  baselineTailMessageId: string | null
}

export type MobileNativeChatSendOrigin = {
  draftKey: string
  pendingKey: string | null
  normalizedText: string
  baselineOccurrences: number
  baselineTailMessageId: string | null
}

type PendingByKey = Record<string, MobileNativeChatPendingMessage[]>

export function combineMobileNativeChatPending(
  session: MobileNativeChatPendingMessage[],
  waiting: readonly MobileNativeChatPendingMessage[]
): MobileNativeChatPendingMessage[] {
  if (waiting.length === 0) {
    return session
  }
  const sessionIds = new Set(session.map((item) => item.id))
  return [...session, ...waiting.filter((item) => !sessionIds.has(item.id))]
}

export function appendMobileNativeChatPending(
  previous: PendingByKey,
  key: string,
  id: string,
  origin: MobileNativeChatSendOrigin,
  text: string,
  images?: string[]
): PendingByKey {
  const current = previous[key] ?? []
  const earlierOutstanding = current.filter(
    (pending) =>
      pending.text.trim() === origin.normalizedText &&
      pending.expectedOccurrence > origin.baselineOccurrences
  ).length
  const expectedImageEchoOrdinal =
    current.filter((pending) => pending.text.trim() === '' && pending.images?.length).length + 1
  return {
    ...previous,
    [key]: [
      ...current,
      {
        id,
        text,
        delivery: 'written',
        expectedOccurrence:
          origin.normalizedText === ''
            ? expectedImageEchoOrdinal
            : origin.baselineOccurrences + earlierOutstanding + 1,
        // Why: earlier outstanding equal sends had not echoed when this tail was captured, so theirs land after it too.
        ...(origin.normalizedText === '' ? {} : { echoOrdinalAfterTail: earlierOutstanding + 1 }),
        baselineTailMessageId: origin.baselineTailMessageId,
        ...(images?.length ? { images } : {})
      }
    ]
  }
}

/** The admission bound passed without a transcript echo. Unknown ids leave the map untouched,
 *  so a bubble its echo already retired is never resurrected. */
export function markMobileNativeChatPendingUnconfirmed(
  previous: PendingByKey,
  id: string
): PendingByKey {
  for (const [key, items] of Object.entries(previous)) {
    const index = items.findIndex((item) => item.id === id && item.delivery !== 'unconfirmed')
    if (index !== -1) {
      const next = items.map((item, i) =>
        i === index ? { ...item, delivery: 'unconfirmed' as const } : item
      )
      return { ...previous, [key]: next }
    }
  }
  return previous
}

export function mergeWaitingSessionPending(
  previous: PendingByKey,
  sessionKey: string,
  waiting: readonly MobileNativeChatPendingMessage[]
): PendingByKey {
  const current = previous[sessionKey] ?? []
  const currentIds = new Set(current.map((item) => item.id))
  const moved = waiting.filter((item) => !currentIds.has(item.id))
  return moved.length > 0 ? { ...previous, [sessionKey]: [...current, ...moved] } : previous
}

export function removeWaitingSessionPending(
  previous: PendingByKey,
  draftKey: string,
  movedIds: ReadonlySet<string>
): PendingByKey {
  const remaining = (previous[draftKey] ?? []).filter((item) => !movedIds.has(item.id))
  if (remaining.length > 0) {
    return { ...previous, [draftKey]: remaining }
  }
  if (!(draftKey in previous)) {
    return previous
  }
  const next = { ...previous }
  delete next[draftKey]
  return next
}
