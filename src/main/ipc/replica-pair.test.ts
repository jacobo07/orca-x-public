import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ReplicaPairCompareResult,
  ReplicaPairRelationsResult,
  ReplicaPairView
} from '../../shared/replica-pair-view'
import { installReplicaPairService } from '../replica-pair-service-slot'
import type { ReplicaPairService } from '../replica-pair-service'

type Handler = (event: unknown, args: unknown) => Promise<unknown> | unknown

const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      handlers.set(channel, handler)
    }
  }
}))

import { registerReplicaPairHandlers } from './replica-pair'

const view: ReplicaPairView = {
  setupId: 's2',
  anchorSetupId: 's1',
  hostId: 'ssh:box',
  relation: { kind: 'unknown', reason: 'not-compared' },
  healthy: false
}
const compareAnswer: ReplicaPairCompareResult = { status: 'ok', pairs: [view] }
const relationsAnswer: ReplicaPairRelationsResult = { status: 'ok', pairs: [view] }

function fakeService(): ReplicaPairService & {
  compare: ReturnType<typeof vi.fn>
  relations: ReturnType<typeof vi.fn>
} {
  return {
    compare: vi.fn(async () => compareAnswer),
    relations: vi.fn(async () => relationsAnswer)
  } as never
}

const unavailable = { status: 'unavailable', reason: 'no-replica-service' }

function call(channel: string, args?: unknown): Promise<unknown> {
  return Promise.resolve(handlers.get(channel)!({}, args))
}

describe('replicaPair IPC channels', () => {
  beforeEach(() => {
    handlers.clear()
    installReplicaPairService(null)
    registerReplicaPairHandlers()
  })

  afterEach(() => {
    installReplicaPairService(null)
  })

  it('exposes exactly the two read channels and no mutating verb', () => {
    expect([...handlers.keys()].sort()).toEqual(['replicaPair:compare', 'replicaPair:relations'])
  })

  it('compare forwards projectId and setupId to the service once and returns its answer unchanged', async () => {
    const service = fakeService()
    installReplicaPairService(service)

    await expect(call('replicaPair:compare', { projectId: 'p1', setupId: 's2' })).resolves.toBe(
      compareAnswer
    )
    await expect(call('replicaPair:compare', { projectId: 'p1' })).resolves.toBe(compareAnswer)

    expect(service.compare).toHaveBeenCalledTimes(2)
    expect(service.compare).toHaveBeenNthCalledWith(1, { projectId: 'p1', setupId: 's2' })
    expect(service.compare.mock.calls[1][0]).toStrictEqual({ projectId: 'p1' })
  })

  it('compare rejects a malformed projectId or setupId before the service is touched', async () => {
    const service = fakeService()
    installReplicaPairService(service)

    for (const args of [
      undefined,
      null,
      {},
      { projectId: '' },
      { projectId: 'x'.repeat(513) },
      { projectId: 42 }
    ]) {
      await expect(call('replicaPair:compare', args)).rejects.toThrow('Invalid projectId')
    }
    for (const setupId of [42, null, '', 'x'.repeat(513)]) {
      await expect(call('replicaPair:compare', { projectId: 'p1', setupId })).rejects.toThrow(
        'Invalid setupId'
      )
    }

    expect(service.compare).not.toHaveBeenCalled()
    // Control: the longest accepted projectId passes the same gate.
    await expect(call('replicaPair:compare', { projectId: 'x'.repeat(512) })).resolves.toBe(
      compareAnswer
    )
    expect(service.compare).toHaveBeenCalledOnce()
  })

  it('relations takes no arguments and returns the service answer unchanged', async () => {
    const service = fakeService()
    installReplicaPairService(service)

    await expect(call('replicaPair:relations')).resolves.toBe(relationsAnswer)
    expect(service.relations).toHaveBeenCalledOnce()
  })

  it('an empty slot answers unavailable, never an empty ok list', async () => {
    await expect(call('replicaPair:compare', { projectId: 'p1' })).resolves.toEqual(unavailable)
    await expect(call('replicaPair:relations')).resolves.toEqual(unavailable)

    // Control: the same calls reach an installed service and get its answer.
    installReplicaPairService(fakeService())
    await expect(call('replicaPair:compare', { projectId: 'p1' })).resolves.toBe(compareAnswer)
    await expect(call('replicaPair:relations')).resolves.toBe(relationsAnswer)
  })

  it('reads the slot at call time, so a service installed after registration is used', async () => {
    await expect(call('replicaPair:relations')).resolves.toEqual(unavailable)
    installReplicaPairService(fakeService())
    await expect(call('replicaPair:relations')).resolves.toBe(relationsAnswer)
  })

  it('registers idempotently: a second registration replaces the first', async () => {
    expect(() => registerReplicaPairHandlers()).not.toThrow()
    installReplicaPairService(fakeService())
    await expect(call('replicaPair:relations')).resolves.toBe(relationsAnswer)
    expect(handlers.size).toBe(2)
  })
})
