import type { FloatingWorkspaceDock } from './ui-chrome-types'

/** Height the bottom dock opens at before the user has resized it. */
export const DEFAULT_FLOATING_WORKSPACE_BOTTOM_HEIGHT = 320

/** Below this the tab strip and one row of output stop coexisting, so the panel reads as broken rather than small. */
export const MIN_FLOATING_WORKSPACE_BOTTOM_HEIGHT = 120

/**
 * Cap as a share of the viewport, not a pixel value: on a short window a fixed cap would let the
 * dock swallow the editor entirely, and a docked panel that leaves no content visible has stopped
 * being a panel.
 */
export const MAX_FLOATING_WORKSPACE_BOTTOM_HEIGHT_RATIO = 0.8

/**
 * The decisions that must agree between the panel (which draws itself) and the shell (which
 * reserves room for it). Both read this one function so a change to either side cannot silently
 * leave the other behind — the failure mode would be a panel covering content it claims to reflow.
 */
export type FloatingWorkspaceDockGeometry = {
  /** Docked panels span the content area edge to edge; floating ones keep their own left/width. */
  anchorsFullWidth: boolean
  /** The single edge a docked panel resizes from. `null` means every floating handle stays live. */
  resizeEdge: 'top' | null
  /** Whether dragging the titlebar repositions the panel. A docked panel has nowhere to go. */
  movable: boolean
  /** Whether the shell shrinks the content area by the panel's height instead of letting it overlap. */
  reservesContentHeight: boolean
}

export function resolveFloatingWorkspaceDockGeometry(
  dock: FloatingWorkspaceDock
): FloatingWorkspaceDockGeometry {
  if (dock === 'bottom') {
    return {
      anchorsFullWidth: true,
      resizeEdge: 'top',
      movable: false,
      reservesContentHeight: true
    }
  }
  return {
    anchorsFullWidth: false,
    resizeEdge: null,
    movable: true,
    reservesContentHeight: false
  }
}

/**
 * Clamp a bottom-dock height against the live viewport.
 *
 * Why the ratio is applied before the floor: on a very short window the ratio cap can fall below
 * the minimum, and taking the minimum last keeps the panel usable rather than honoring a cap that
 * would collapse it. A non-finite or absent viewport falls back to the stored height's own floor
 * so a measurement gap never silently resets the user's size.
 */
export function clampFloatingWorkspaceBottomHeight(
  height: number,
  viewportHeight: number | null | undefined
): number {
  const requested = Number.isFinite(height)
    ? height
    : DEFAULT_FLOATING_WORKSPACE_BOTTOM_HEIGHT
  if (!Number.isFinite(viewportHeight) || (viewportHeight ?? 0) <= 0) {
    return Math.max(MIN_FLOATING_WORKSPACE_BOTTOM_HEIGHT, requested)
  }
  const ceiling = (viewportHeight as number) * MAX_FLOATING_WORKSPACE_BOTTOM_HEIGHT_RATIO
  return Math.max(MIN_FLOATING_WORKSPACE_BOTTOM_HEIGHT, Math.min(requested, ceiling))
}
