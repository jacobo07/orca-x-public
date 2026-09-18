import { describe, expect, it } from 'vitest'
import {
  LiveSessionMaterializationReservations,
  MATERIALIZATION_BOUND_CEILING_MS,
  MATERIALIZATION_UNBOUND_CEILING_MS,
  MAX_MATERIALIZATION_RESERVATIONS
} from './live-session-materialization-reservation'

function setup() {
  let now = 1_000
  const boundTabs = new Set<string>()
  const reservations = new LiveSessionMaterializationReservations({
    now: () => now,
    hasBoundPty: (tabId) => boundTabs.has(tabId)
  })
  return {
    reservations,
    boundTabs,
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe('LiveSessionMaterializationReservations', () => {
  it('grants one operation per key and contends every other', () => {
    const { reservations } = setup()

    expect(reservations.tryAcquire('key-s', 'op-a', 1)).toBe('granted')
    expect(reservations.tryAcquire('key-s', 'op-b', 2)).toBe('contended')
    expect(reservations.holder('key-s')).toEqual({
      operationId: 'op-a',
      ownerId: 1,
      phase: 'reserved'
    })
  })

  it('keeps unrelated keys independent', () => {
    const { reservations } = setup()

    expect(reservations.tryAcquire('key-s', 'op-a', 1)).toBe('granted')
    expect(reservations.tryAcquire('key-t', 'op-b', 1)).toBe('granted')
  })

  it('answers a retry of the same operation as already held, not as a rival', () => {
    const { reservations } = setup()
    reservations.tryAcquire('key-s', 'op-a', 1)

    expect(reservations.tryAcquire('key-s', 'op-a', 1)).toBe('held-by-self')
    // Same id from another window is not the same operation.
    expect(reservations.tryAcquire('key-s', 'op-a', 2)).toBe('contended')
  })

  it('lets only the owning operation release', () => {
    const { reservations } = setup()
    reservations.tryAcquire('key-s', 'op-a', 1)

    reservations.release('op-b', 2)
    reservations.release('op-a', 2)
    expect(reservations.holder('key-s')?.operationId).toBe('op-a')

    reservations.release('op-a', 1)
    expect(reservations.holder('key-s')).toBeNull()
    expect(reservations.tryAcquire('key-s', 'op-b', 2)).toBe('granted')
  })

  it('refuses a tab attach from anyone but the owner', () => {
    const { reservations } = setup()
    reservations.tryAcquire('key-s', 'op-a', 1)

    expect(reservations.attachTab('op-a', 2, 'tab-x')).toBe(false)
    expect(reservations.attachTab('op-a', 1, 'tab-a')).toBe(true)
    reservations.releaseForTab('tab-x')
    expect(reservations.holder('key-s')).not.toBeNull()
  })

  it('holds through a bound runtime and releases on its tab', () => {
    const { reservations, boundTabs, advance } = setup()
    reservations.tryAcquire('key-s', 'op-a', 1)
    reservations.attachTab('op-a', 1, 'tab-a')
    boundTabs.add('tab-a')
    advance(MATERIALIZATION_UNBOUND_CEILING_MS + 1)

    expect(reservations.holder('key-s')).toEqual({
      operationId: 'op-a',
      ownerId: 1,
      phase: 'bound',
      tabId: 'tab-a'
    })
    reservations.releaseForTab('tab-a')
    expect(reservations.holder('key-s')).toBeNull()
  })

  it('reaps an attempt that never spawned, and only after the ceiling', () => {
    const { reservations, advance } = setup()
    reservations.tryAcquire('key-s', 'op-a', 1)
    reservations.attachTab('op-a', 1, 'tab-a')

    advance(MATERIALIZATION_UNBOUND_CEILING_MS)
    expect(reservations.holder('key-s')).not.toBeNull()
    advance(1)
    expect(reservations.holder('key-s')).toBeNull()
    expect(reservations.size).toBe(0)
  })

  it('drops a reservation whose bound runtime disappeared without handing off', () => {
    const { reservations, boundTabs } = setup()
    reservations.tryAcquire('key-s', 'op-a', 1)
    reservations.attachTab('op-a', 1, 'tab-a')
    boundTabs.add('tab-a')
    expect(reservations.holder('key-s')?.phase).toBe('bound')

    boundTabs.delete('tab-a')
    expect(reservations.holder('key-s')).toBeNull()
  })

  it('reaps a bound runtime that never reported, after the boot ceiling', () => {
    const { reservations, boundTabs, advance } = setup()
    reservations.tryAcquire('key-s', 'op-a', 1)
    reservations.attachTab('op-a', 1, 'tab-a')
    boundTabs.add('tab-a')
    reservations.holder('key-s')

    advance(MATERIALIZATION_BOUND_CEILING_MS)
    expect(reservations.holder('key-s')).not.toBeNull()
    advance(1)
    expect(reservations.holder('key-s')).toBeNull()
  })

  it("drops a closed window's reservations only", () => {
    const { reservations } = setup()
    reservations.tryAcquire('key-s', 'op-a', 1)
    reservations.tryAcquire('key-t', 'op-b', 2)

    reservations.releaseForOwner(1)
    expect(reservations.holder('key-s')).toBeNull()
    expect(reservations.holder('key-t')).not.toBeNull()
  })

  it('refuses beyond capacity after reaping what has expired', () => {
    const { reservations, advance } = setup()
    for (let i = 0; i < MAX_MATERIALIZATION_RESERVATIONS; i += 1) {
      expect(reservations.tryAcquire(`key-${i}`, `op-${i}`, 1)).toBe('granted')
    }
    expect(reservations.tryAcquire('key-over', 'op-over', 1)).toBe('capacity')

    advance(MATERIALIZATION_UNBOUND_CEILING_MS + 1)
    expect(reservations.tryAcquire('key-over', 'op-over', 1)).toBe('granted')
    expect(reservations.size).toBe(1)
  })
})
