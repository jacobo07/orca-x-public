import {
  HOST_WAKE_BROKER_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../shared/protocol-version'
import type { WakeBroker, WakeBrokerStoreView, WakeDeviceAuthority } from './wake-broker'

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
