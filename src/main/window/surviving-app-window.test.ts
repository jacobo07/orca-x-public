/**
 * The fallback several process-wide services use once the window they captured has closed.
 *
 * Both directions matter. Returning a window when none is alive would have watchers notifying dead
 * chrome; returning null while one is alive is the bug this exists to fix — the survivor left with
 * services that idle because a window it never depended on went away.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { setSurvivingAppWindowResolver, survivingAppWindow } from './surviving-app-window'

function windowStub(destroyed = false) {
  return { isDestroyed: () => destroyed } as never
}

afterEach(() => {
  setSurvivingAppWindowResolver(null)
})

describe('survivingAppWindow', () => {
  it('has no survivor until the host names one', () => {
    // The single-window default: nothing set, so a closed window still means stop.
    expect(survivingAppWindow()).toBeNull()
  })

  it('returns the live window the host resolves', () => {
    const survivor = windowStub()
    setSurvivingAppWindowResolver(() => survivor)

    expect(survivingAppWindow()).toBe(survivor)
  })

  it('treats a destroyed resolved window as no survivor', () => {
    setSurvivingAppWindowResolver(() => windowStub(true))

    expect(survivingAppWindow()).toBeNull()
  })

  it('stops resolving once the host clears it', () => {
    setSurvivingAppWindowResolver(() => windowStub())
    setSurvivingAppWindowResolver(null)

    expect(survivingAppWindow()).toBeNull()
  })
})
