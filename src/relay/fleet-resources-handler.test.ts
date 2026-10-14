import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerFleetResourcesHandler } from './fleet-resources-handler'
import {
  FLEET_RESOURCES_RELAY_CAPABILITY,
  FLEET_RESOURCES_RELAY_METHOD
} from '../shared/fleet-relay-resources'
import { fleetSampleFromSnapshot } from '../shared/fleet-resource-observation'

type Handler = (params: unknown) => Promise<unknown>

function register(collect = async () => HOST): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  registerFleetResourcesHandler(
    {
      onRequest: (method: string, handler: Handler) => void handlers.set(method, handler)
    } as never,
    { collect, platform: 'linux', arch: 'x64' }
  )
  return handlers
}

const HOST = {
  totalMemory: 100,
  freeMemory: 10,
  availableMemory: 60,
  availableMemorySource: 'proc-meminfo' as const,
  usedMemory: 40,
  memoryUsagePercent: 40,
  cpuCoreCount: 4,
  loadAverage1m: 0.5
}

describe('fleet.resources relay method', () => {
  it('answers host memory in the shape the desktop parser reads', async () => {
    const reply = await register().get(FLEET_RESOURCES_RELAY_METHOD)!({})
    expect(reply).toEqual({
      platform: 'linux',
      arch: 'x64',
      host: { totalMemory: 100, availableMemory: 60, availableMemorySource: 'proc-meminfo' }
    })
    expect(fleetSampleFromSnapshot(reply, null, 1)).toMatchObject({
      outcome: 'measured',
      availableMemory: 60,
      availableMemorySource: 'proc-meminfo'
    })
  })

  it('a collection failure rejects the request instead of answering zeros', async () => {
    const handler = register(async () => {
      throw new Error('procfs gone')
    }).get(FLEET_RESOURCES_RELAY_METHOD)!
    await expect(handler({})).rejects.toThrow('procfs gone')
  })

  it('relay.status advertises the capability (the host only asks when advertised)', () => {
    const relay = readFileSync(join(__dirname, 'relay.ts'), 'utf8')
    const status = relay.slice(relay.indexOf("onRequest('relay.status'"))
    expect(status.slice(0, status.indexOf('],'))).toContain('...FLEET_RESOURCES_RELAY_CAPABILITIES')
    expect(relay).toContain('registerFleetResourcesHandler(dispatcher)')
    expect(FLEET_RESOURCES_RELAY_CAPABILITY).toBe('fleet.resources.v1')
  })
})
