import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { mobileNativeChatDeliveryCaption } from './mobile-native-chat-delivery-evidence'
import {
  appendMobileNativeChatPending,
  markMobileNativeChatPendingUnconfirmed,
  type MobileNativeChatSendOrigin
} from './mobile-native-chat-pending-echo'
import { buildMobileNativeChatTransientData } from './mobile-native-chat-render-data'

const origin: MobileNativeChatSendOrigin = {
  draftKey: 'draft',
  pendingKey: 'draft\0session',
  normalizedText: 'ping',
  baselineOccurrences: 0,
  baselineTailMessageId: null
}

const transcriptUser = (id: string, text: string): NativeChatMessage => ({
  id,
  role: 'user',
  blocks: [{ type: 'text', text }],
  timestamp: null,
  source: 'transcript'
})

describe('pending chat delivery evidence', () => {
  it('starts every accepted bubble as written, never as delivered', () => {
    const map = appendMobileNativeChatPending({}, origin.pendingKey!, 'p1', origin, 'ping')
    expect(map[origin.pendingKey!]!.map((item) => item.delivery)).toEqual(['written'])
  })

  it('marks only the bubble whose admission bound passed', () => {
    let map = appendMobileNativeChatPending({}, origin.pendingKey!, 'p1', origin, 'ping')
    map = appendMobileNativeChatPending(map, origin.pendingKey!, 'p2', origin, 'pong')
    const next = markMobileNativeChatPendingUnconfirmed(map, 'p1')
    expect(next[origin.pendingKey!]!.map((item) => [item.id, item.delivery])).toEqual([
      ['p1', 'unconfirmed'],
      ['p2', 'written']
    ])
  })

  it('never resurrects a bubble its transcript echo already retired', () => {
    const map = appendMobileNativeChatPending({}, origin.pendingKey!, 'p2', origin, 'pong')
    expect(markMobileNativeChatPendingUnconfirmed(map, 'p1')).toBe(map)
    expect(markMobileNativeChatPendingUnconfirmed({}, 'p1')).toEqual({})
  })

  it('carries delivery state for pending echoes only, never for transcript turns', () => {
    const { deliveryByMessageId, data } = buildMobileNativeChatTransientData({
      folded: [transcriptUser('m1', 'earlier')],
      streaming: null,
      pending: [
        { id: 'p1', delivery: 'written', text: 'ping' },
        { id: 'p2', delivery: 'unconfirmed', text: 'pong' }
      ]
    })
    expect(data.map((message) => message.id)).toEqual(['m1', 'p1', 'p2'])
    expect(deliveryByMessageId).toEqual({ p1: 'written', p2: 'unconfirmed' })
  })

  it('words a written bubble differently from an unconfirmed one, and neither as sent', () => {
    const written = mobileNativeChatDeliveryCaption('written')
    const unconfirmed = mobileNativeChatDeliveryCaption('unconfirmed')
    expect(written).not.toBe(unconfirmed)
    expect(written).toMatch(/waiting for the agent/)
    expect(unconfirmed).toMatch(/before resending/)
  })
})
