import { describe, expect, it, vi } from 'vitest'

vi.mock('../daemon/daemon-init', () => ({ getDaemonProvider: () => null }))

const { listConnectedDaemonPids } = await import('./terminal-host-daemon-pids')

function adapter(pid: number | null) {
  return {
    getConnectedDaemonIdentity: () =>
      pid === null ? null : { pid, startedAtMs: 1, launchNonce: 'n' }
  }
}

describe('listConnectedDaemonPids', () => {
  it('returns nothing when no provider exists', () => {
    expect(listConnectedDaemonPids(null)).toEqual([])
  })

  it('reads a single adapter provider', () => {
    expect(listConnectedDaemonPids(adapter(500))).toEqual([500])
  })

  it('fans out across current and legacy adapters, skipping disconnected ones', () => {
    const provider = { getAllAdapters: () => [adapter(500), adapter(null), adapter(400)] }
    expect(listConnectedDaemonPids(provider)).toEqual([500, 400])
  })

  it('dedupes a pid reported by two adapters and rejects invalid pids', () => {
    const provider = {
      getAllAdapters: () => [adapter(500), adapter(500), adapter(0), adapter(-3), {}]
    }
    expect(listConnectedDaemonPids(provider)).toEqual([500])
  })
})
