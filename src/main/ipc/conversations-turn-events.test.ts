import { describe, expect, it, vi } from 'vitest'

import type { AgentTurnEvent } from '../../shared/agent-turn-event'

const windows = vi.hoisted(() => ({ sent: [] as unknown[] }))
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: (_c: string, p: unknown) => windows.sent.push(p) }
      }
    ]
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))

import { broadcastTurnEvent, subscribeConversationTurnEvents } from './conversations'

const EVENT = { type: 'turn-started' } as unknown as AgentTurnEvent

describe('conversation turn events reach windows AND paired-client subscribers', () => {
  it('delivers one emit to every window and every runtime subscriber', () => {
    windows.sent.length = 0
    const received: unknown[] = []
    const stop = subscribeConversationTurnEvents((payload) => received.push(payload))

    broadcastTurnEvent('conv_1', EVENT)
    stop()
    broadcastTurnEvent('conv_1', EVENT)

    expect(windows.sent).toHaveLength(2)
    expect(received).toEqual([{ conversationId: 'conv_1', event: EVENT }])
  })

  it('does not let one failing subscriber stop the others or the turn', () => {
    const received: unknown[] = []
    const stopBad = subscribeConversationTurnEvents(() => {
      throw new Error('a paired client went away mid-send')
    })
    const stopGood = subscribeConversationTurnEvents((payload) => received.push(payload))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => broadcastTurnEvent('conv_2', EVENT)).not.toThrow()
    expect(received).toEqual([{ conversationId: 'conv_2', event: EVENT }])

    stopBad()
    stopGood()
    warn.mockRestore()
  })
})
