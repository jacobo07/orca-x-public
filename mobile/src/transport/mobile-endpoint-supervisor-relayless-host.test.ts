import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bundle,
  dependencies,
  FakeLogicalClient,
  host
} from './mobile-endpoint-supervisor-test-fakes'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import type { HostProfile } from './types'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

// Why: the shared `host` fixture always carries `relay` + `relayHostId`, so every
// other test in this subsystem supplies the precondition production may lack. A
// host paired over a direct route has neither, and `relay` is optional on both
// HostProfile and the stored schema — so this is a reachable production state,
// not a synthetic one.
const relaylessHost: HostProfile = {
  ...host,
  relay: undefined,
  relayHostId: undefined,
  endpoints: [{ id: 'direct-primary', kind: 'lan', url: 'ws://192.168.1.10:6768' }]
}

describe('supervisor on a host that has no relay endpoint', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // CHARACTERIZATION — asserts the behaviour as it stands at this commit, so the
  // fix commit inverts it and the diff is the evidence. Measured on a real device
  // 2026-09-14: 8 background/foreground cycles, 24,797 logcat lines, zero relay
  // activity, every dial to one pinned endpoint. See docs/mobile-relay-bootstrap-spec.md.
  it('never attempts relay, even though the direct client is down', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const deps = dependencies({ readBundle: vi.fn(async () => null) })
    const supervisor = new MobileEndpointSupervisor(logical, relaylessHost, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(deps.openRelay).not.toHaveBeenCalled()
    // The director fallback is exactly the machinery that could ACQUIRE a relay
    // for this host, and it is unreachable because acquiring one requires having one.
    expect(deps.resolveRelay).not.toHaveBeenCalled()
    expect(logical.getActivePath()).toBe('lan')
    supervisor.stop()
  })

  it('stays inert across later direct failures, not merely at start', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const deps = dependencies({ readBundle: vi.fn(async () => null) })
    const supervisor = new MobileEndpointSupervisor(logical, relaylessHost, deps)
    await supervisor.start()

    // Drive the states a real retry loop publishes while a pinned endpoint is dead.
    logical.publishState('reconnecting')
    await vi.advanceTimersByTimeAsync(5_000)
    logical.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(deps.openRelay).not.toHaveBeenCalled()
    expect(deps.resolveRelay).not.toHaveBeenCalled()
    supervisor.stop()
  })

  it('is gated on the host relay, not on the credential bundle', async () => {
    // A readable bundle changes nothing: start() returns before it is consulted,
    // so this pins WHICH branch is taken rather than merely that nothing happened.
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const deps = dependencies({ readBundle: vi.fn(async () => bundle) })
    const supervisor = new MobileEndpointSupervisor(logical, relaylessHost, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(deps.readBundle).toHaveBeenCalled()
    expect(deps.openRelay).not.toHaveBeenCalled()
    supervisor.stop()
  })

  // POSITIVE CONTROL — without this, all three assertions above would pass against
  // a supervisor that never ran at all, a broken fixture, or a mis-wired dependency
  // set. It proves the harness CAN observe a relay dial.
  it('control: the same scenario WITH a relay does fail over', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(deps.openRelay).toHaveBeenCalled()
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })
})
