import { describe, expect, it } from 'vitest'
import { judgeMobileDriverLease, MOBILE_DRIVER_LEASE_MS } from './mobile-driver-lease'

const NOW = 10_000_000

describe('judgeMobileDriverLease', () => {
  it('keeps a recent phone action active and says how long remains', () => {
    expect(
      judgeMobileDriverLease({
        driverIsMobile: true,
        phoneLastActedAts: [NOW - 30_000],
        phoneInputPending: false,
        now: NOW
      })
    ).toEqual({ kind: 'active', remainingMs: MOBILE_DRIVER_LEASE_MS - 30_000 })
  })

  it('expires once no phone has acted for the lease', () => {
    expect(
      judgeMobileDriverLease({
        driverIsMobile: true,
        phoneLastActedAts: [NOW - MOBILE_DRIVER_LEASE_MS],
        phoneInputPending: false,
        now: NOW
      })
    ).toEqual({ kind: 'expired' })
  })

  it('lets the newest action of any phone renew the lease', () => {
    expect(
      judgeMobileDriverLease({
        driverIsMobile: true,
        phoneLastActedAts: [NOW - 10 * MOBILE_DRIVER_LEASE_MS, NOW - 1_000],
        phoneInputPending: false,
        now: NOW
      }).kind
    ).toBe('active')
  })

  it('keeps the lease while a phone write is in flight', () => {
    expect(
      judgeMobileDriverLease({
        driverIsMobile: true,
        phoneLastActedAts: [NOW - 10 * MOBILE_DRIVER_LEASE_MS],
        phoneInputPending: true,
        now: NOW
      }).kind
    ).toBe('active')
  })

  it('does not apply without a phone driver or without a subscribed phone', () => {
    const old = [NOW - 10 * MOBILE_DRIVER_LEASE_MS]
    expect(
      judgeMobileDriverLease({
        driverIsMobile: false,
        phoneLastActedAts: old,
        phoneInputPending: false,
        now: NOW
      }).kind
    ).toBe('not-applicable')
    expect(
      judgeMobileDriverLease({
        driverIsMobile: true,
        phoneLastActedAts: [],
        phoneInputPending: false,
        now: NOW
      }).kind
    ).toBe('not-applicable')
  })
})
