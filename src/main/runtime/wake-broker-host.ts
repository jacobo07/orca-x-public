import {
  HOST_WAKE_BROKER_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../shared/protocol-version'
import {
  createWakeBroker,
  mintWakeId,
  type WakeBroker,
  type WakeBrokerDeps,
  type WakeBrokerStoreView,
  type WakeDeviceAuthority
} from './wake-broker'
import { loadWakeBrokerStore, type WakeBrokerStoreDeps } from './wake-broker-store'
import { sendMagicPacketUdp } from './wake-magic-packet'

export type EnabledWakeBroker = { broker: WakeBroker; store: WakeBrokerStoreView }

export type WakeBrokerHost = {
  enable(next: EnabledWakeBroker): void
  markUnavailable(reason: string): void
  disable(): void
  current(): EnabledWakeBroker | null
  unavailableReason(): string | null
  attachDeviceAuthority(authority: WakeDeviceAuthority | null): void
  authority(): WakeDeviceAuthority | null
}

export function createWakeBrokerHost(): WakeBrokerHost {
  let enabled: EnabledWakeBroker | null = null
  let unavailable: string | null = null
  let deviceAuthority: WakeDeviceAuthority | null = null
  return {
    enable(next) {
      enabled = next
      unavailable = null
    },
    markUnavailable(reason) {
      enabled = null
      unavailable = reason
    },
    disable() {
      enabled = null
      unavailable = null
    },
    current: () => enabled,
    unavailableReason: () => unavailable,
    attachDeviceAuthority(authority) {
      deviceAuthority = authority
    },
    authority: () => deviceAuthority
  }
}

// Why module scope: the RPC methods, the serve start path and runtime-rpc.ts must share one broker.
export const wakeBrokerHost = createWakeBrokerHost()

export function wakeBrokerRuntimeCapabilities(): RuntimeCapability[] {
  return wakeBrokerHost.current() ? [HOST_WAKE_BROKER_RUNTIME_CAPABILITY] : []
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown_error'
}

export type WakeBrokerStart =
  | { state: 'enabled'; targetCount: number }
  | { state: 'unavailable'; reason: string }

export type WakeBrokerStartDeps = {
  sendMagicPacket?: WakeBrokerDeps['sendMagicPacket']
  publish?: WakeBrokerStoreDeps['publish']
}

export function startWakeBroker(
  userDataPath: string,
  deps: WakeBrokerStartDeps = {}
): WakeBrokerStart {
  const loaded = loadWakeBrokerStore(userDataPath, deps.publish ? { publish: deps.publish } : {})
  if (!loaded.ok) {
    wakeBrokerHost.markUnavailable(loaded.reason)
    console.error(`[wake-broker] broker unavailable: ${loaded.reason}`)
    return { state: 'unavailable', reason: loaded.reason }
  }
  const { store } = loaded
  const broker = createWakeBroker({
    now: Date.now,
    store,
    authority: () => wakeBrokerHost.authority(),
    sendMagicPacket: deps.sendMagicPacket ?? sendMagicPacketUdp,
    newWakeId: mintWakeId
  })
  wakeBrokerHost.enable({ broker, store })
  const authority = wakeBrokerHost.authority()
  if (authority) {
    // Why once at start: grants of devices removed while the broker was off must not linger on disk.
    try {
      store.pruneGrants((deviceId) => authority.deviceExists(deviceId))
    } catch (error) {
      // Why fail-open: removals apply in memory before the write, and the effect re-judges the device anyway.
      console.error(`[wake-broker] grant prune not persisted: ${errorCode(error)}`)
    }
  }
  return { state: 'enabled', targetCount: store.targets().length }
}
