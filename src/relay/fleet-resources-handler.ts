import type { RelayDispatcher } from './dispatcher'
import { collectHostMemory } from '../main/memory/host-memory'
import { FLEET_RESOURCES_RELAY_METHOD } from '../shared/fleet-relay-resources'
import type { HostMemory } from '../shared/process-stats-types'

export { FLEET_RESOURCES_RELAY_CAPABILITIES } from '../shared/fleet-relay-resources'

export type FleetResourcesDeps = {
  collect: () => Promise<HostMemory>
  platform: NodeJS.Platform
  arch: string
}

/** Same `host` shape as the desktop's memory snapshot, so one parser reads both. */
export function registerFleetResourcesHandler(
  dispatcher: Pick<RelayDispatcher, 'onRequest'>,
  deps: FleetResourcesDeps = {
    collect: collectHostMemory,
    platform: process.platform,
    arch: process.arch
  }
): void {
  dispatcher.onRequest(FLEET_RESOURCES_RELAY_METHOD, async () => {
    const host = await deps.collect()
    return {
      platform: deps.platform,
      arch: deps.arch,
      host: {
        totalMemory: host.totalMemory,
        availableMemory: host.availableMemory,
        availableMemorySource: host.availableMemorySource
      }
    }
  })
}
