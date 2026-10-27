export type MobileDriverOverlayCollapseState = {
  driverClientId: string | null
  collapsed: boolean
  /** Desktop keystrokes the lock had dropped when this state was last settled. */
  refusals: number
}

// Why: a phone taking control is normal remote use, so a new driver starts as the quiet chip;
// the full explanation opens when a desktop keystroke is actually dropped.
export function getMobileDriverOverlayCollapseState(
  state: MobileDriverOverlayCollapseState,
  driverClientId: string | null,
  refusals = 0
): MobileDriverOverlayCollapseState {
  if (state.driverClientId !== driverClientId) {
    return createMobileDriverOverlayCollapseState(driverClientId, refusals)
  }
  if (refusals > state.refusals) {
    return { driverClientId, collapsed: false, refusals }
  }
  return state
}

export function createMobileDriverOverlayCollapseState(
  driverClientId: string | null,
  refusals = 0
): MobileDriverOverlayCollapseState {
  return {
    driverClientId,
    collapsed: true,
    refusals
  }
}
