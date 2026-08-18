import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FLOATING_WORKSPACE_BOTTOM_HEIGHT,
  MAX_FLOATING_WORKSPACE_BOTTOM_HEIGHT_RATIO,
  MIN_FLOATING_WORKSPACE_BOTTOM_HEIGHT,
  clampFloatingWorkspaceBottomHeight,
  resolveFloatingWorkspaceDockGeometry
} from './floating-workspace-dock'

describe('resolveFloatingWorkspaceDockGeometry', () => {
  it('spans the content area only when docked', () => {
    expect(resolveFloatingWorkspaceDockGeometry('bottom').anchorsFullWidth).toBe(true)
    expect(resolveFloatingWorkspaceDockGeometry('floating').anchorsFullWidth).toBe(false)
  })

  it('restricts a docked panel to its top edge and leaves floating handles live', () => {
    expect(resolveFloatingWorkspaceDockGeometry('bottom').resizeEdge).toBe('top')
    expect(resolveFloatingWorkspaceDockGeometry('floating').resizeEdge).toBeNull()
  })

  it('only lets the floating panel be dragged', () => {
    expect(resolveFloatingWorkspaceDockGeometry('bottom').movable).toBe(false)
    expect(resolveFloatingWorkspaceDockGeometry('floating').movable).toBe(true)
  })

  // The whole point of the bottom dock: content shrinks rather than being covered.
  it('reserves content height only when docked', () => {
    expect(resolveFloatingWorkspaceDockGeometry('bottom').reservesContentHeight).toBe(true)
    expect(resolveFloatingWorkspaceDockGeometry('floating').reservesContentHeight).toBe(false)
  })

  // Drift guard: if a future edit makes one mode's decision match the other's across the board,
  // the two modes have collapsed into one and the setting no longer does anything.
  it('never resolves the two modes to the same geometry', () => {
    expect(resolveFloatingWorkspaceDockGeometry('bottom')).not.toEqual(
      resolveFloatingWorkspaceDockGeometry('floating')
    )
  })
})

describe('clampFloatingWorkspaceBottomHeight', () => {
  it('keeps a height that fits', () => {
    expect(clampFloatingWorkspaceBottomHeight(400, 1000)).toBe(400)
  })

  it('raises a height below the usable floor', () => {
    expect(clampFloatingWorkspaceBottomHeight(10, 1000)).toBe(
      MIN_FLOATING_WORKSPACE_BOTTOM_HEIGHT
    )
  })

  it('caps a height at the viewport share so content stays visible', () => {
    expect(clampFloatingWorkspaceBottomHeight(5000, 1000)).toBe(
      1000 * MAX_FLOATING_WORKSPACE_BOTTOM_HEIGHT_RATIO
    )
  })

  // On a very short window the ratio cap falls under the floor; honoring the cap there would
  // collapse the panel, so the floor has to win.
  it('prefers the floor over a ratio cap that would collapse the panel', () => {
    expect(clampFloatingWorkspaceBottomHeight(300, 100)).toBe(
      MIN_FLOATING_WORKSPACE_BOTTOM_HEIGHT
    )
  })

  // A measurement gap must not be mistaken for "no room" — that would quietly shrink the user's
  // panel every time the height is read before the viewport is known.
  it('keeps the stored height when the viewport is not measurable', () => {
    expect(clampFloatingWorkspaceBottomHeight(400, null)).toBe(400)
    expect(clampFloatingWorkspaceBottomHeight(400, undefined)).toBe(400)
    expect(clampFloatingWorkspaceBottomHeight(400, 0)).toBe(400)
    expect(clampFloatingWorkspaceBottomHeight(400, Number.NaN)).toBe(400)
  })

  it('falls back to the default when the stored height is not a number', () => {
    expect(clampFloatingWorkspaceBottomHeight(Number.NaN, 1000)).toBe(
      DEFAULT_FLOATING_WORKSPACE_BOTTOM_HEIGHT
    )
  })
})
