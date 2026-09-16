import { getDaemonProvider } from '../daemon/daemon-init'
import type { DaemonEndpointIdentity } from '../daemon/daemon-hello-protocol'

type ConnectedIdentitySource = {
  getConnectedDaemonIdentity(): DaemonEndpointIdentity | null
}

type DaemonProviderShape = ConnectedIdentitySource | { getAllAdapters(): readonly unknown[] }

/**
 * Pids of every daemon generation this process is connected to right now.
 *
 * Why connected-only: an open authenticated socket means the process still exists, so its pid
 * cannot have been recycled. A remembered identity from a closed connection could name anything.
 */
export function listConnectedDaemonPids(
  provider: DaemonProviderShape | null = getDaemonProvider()
): number[] {
  if (!provider) {
    return []
  }
  const adapters = 'getAllAdapters' in provider ? provider.getAllAdapters() : [provider]
  const pids = new Set<number>()
  for (const adapter of adapters) {
    if (!isConnectedIdentitySource(adapter)) {
      continue
    }
    const pid = adapter.getConnectedDaemonIdentity()?.pid
    if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) {
      pids.add(pid)
    }
  }
  return [...pids]
}

function isConnectedIdentitySource(value: unknown): value is ConnectedIdentitySource {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<ConnectedIdentitySource>).getConnectedDaemonIdentity === 'function'
  )
}
