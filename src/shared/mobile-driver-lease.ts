// Why: a phone that only watches must not hold a terminal forever. Once no phone has acted for this
// long, the next desktop keystroke takes the terminal back. See docs/mobile-presence-lock.md.
export const MOBILE_DRIVER_LEASE_MS = 2 * 60_000

export type MobileDriverLeaseVerdict =
  | { kind: 'expired' }
  | { kind: 'active'; remainingMs: number }
  // Not a phone-held lease: no phone driver, or no phone subscribed (stale lock or held fit).
  | { kind: 'not-applicable' }

export function judgeMobileDriverLease(input: {
  driverIsMobile: boolean
  phoneLastActedAts: readonly number[]
  phoneInputPending: boolean
  now: number
}): MobileDriverLeaseVerdict {
  if (!input.driverIsMobile || input.phoneLastActedAts.length === 0) {
    return { kind: 'not-applicable' }
  }
  if (input.phoneInputPending) {
    return { kind: 'active', remainingMs: MOBILE_DRIVER_LEASE_MS }
  }
  const idleMs = input.now - Math.max(...input.phoneLastActedAts)
  if (idleMs >= MOBILE_DRIVER_LEASE_MS) {
    return { kind: 'expired' }
  }
  return { kind: 'active', remainingMs: MOBILE_DRIVER_LEASE_MS - idleMs }
}
