import { describe, expect, it } from 'vitest'
import {
  createMobileDriverOverlayCollapseState,
  getMobileDriverOverlayCollapseState
} from './mobile-driver-overlay-collapse'

describe('mobile driver overlay collapse state', () => {
  it('starts a new phone driver as the quiet chip', () => {
    expect(createMobileDriverOverlayCollapseState('phone-1')).toEqual({
      driverClientId: 'phone-1',
      collapsed: true,
      refusals: 0
    })
  })

  it('preserves an expanded state for the same mobile driver', () => {
    const state = { driverClientId: 'phone-1', collapsed: false, refusals: 0 }
    expect(getMobileDriverOverlayCollapseState(state, 'phone-1', 0)).toBe(state)
  })

  it('returns to the chip when a different phone takes over', () => {
    expect(
      getMobileDriverOverlayCollapseState(
        { driverClientId: 'phone-1', collapsed: false, refusals: 2 },
        'phone-2',
        2
      )
    ).toEqual({ driverClientId: 'phone-2', collapsed: true, refusals: 2 })
  })

  it('expands when the lock drops a new desktop keystroke', () => {
    expect(
      getMobileDriverOverlayCollapseState(
        { driverClientId: 'phone-1', collapsed: true, refusals: 1 },
        'phone-1',
        2
      )
    ).toEqual({ driverClientId: 'phone-1', collapsed: false, refusals: 2 })
  })

  it('stays collapsed after the user collapses it until another keystroke is dropped', () => {
    const collapsedAfterExplaining = { driverClientId: 'phone-1', collapsed: true, refusals: 2 }
    expect(getMobileDriverOverlayCollapseState(collapsedAfterExplaining, 'phone-1', 2)).toBe(
      collapsedAfterExplaining
    )
  })
})
