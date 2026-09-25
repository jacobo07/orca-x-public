import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, args: unknown) => Promise<unknown>>()
const trusted = { value: false }
const decided: unknown[] = []

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: (event: unknown, args: unknown) => Promise<unknown>) => handlers.set(channel, handler)
  }
}))
vi.mock('./ui', () => ({ isTrustedUIRenderer: () => trusted.value }))
vi.mock('../runtime/orchestration/agent-federation-view', () => ({
  readAgentFederationView: async () => ({ outcome: 'loaded', reviews: [], approvals: [] }),
  decideAgentApproval: async (_db: unknown, input: unknown) => {
    decided.push(input)
    return { outcome: 'decided', decision: 'approved' }
  },
  rebindAgentApproval: async () => ({ outcome: 'decided', decision: 'rebound' })
}))

import { registerAgentFederationHandlers } from './agent-federation'

const decide = { gateId: 'gate_1', decision: 'approved', revision: 'a'.repeat(40), patchHash: 'h' }

describe('the approval channels', () => {
  beforeEach(() => {
    handlers.clear()
    decided.length = 0
    registerAgentFederationHandlers(() => ({}) as never)
  })

  it('refuses a decision from anything but Orca’s own window, before it reaches the authority', async () => {
    trusted.value = false

    await expect(handlers.get('federation:decideGate')!({ sender: {} }, decide)).rejects.toThrow(/Orca’s own window/)
    await expect(handlers.get('federation:rebindGate')!({ sender: {} }, { gateId: 'gate_1' })).rejects.toThrow(/Orca’s own window/)
    expect(decided).toEqual([])
  })

  it('passes a decision from Orca’s window with exactly the revision the person was shown', async () => {
    trusted.value = true

    await handlers.get('federation:decideGate')!({ sender: {} }, decide)

    expect(decided).toEqual([{ gateId: 'gate_1', decision: 'approved', observed: { revision: 'a'.repeat(40), patchHash: 'h' } }])
  })

  it('accepts only approve or reject, and a view only for a well-formed agent id', async () => {
    trusted.value = true

    await expect(handlers.get('federation:decideGate')!({ sender: {} }, { ...decide, decision: 'maybe' })).rejects.toThrow()
    await expect(handlers.get('federation:agentView')!({ sender: {} }, { agentId: '../x' })).rejects.toThrow(/agentId/)
  })
})
