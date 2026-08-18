import { describe, expect, it } from 'vitest'
import {
  MAX_FLOATING_WORKSPACE_BOTTOM_HEIGHT_RATIO,
  MIN_FLOATING_WORKSPACE_BOTTOM_HEIGHT
} from '../../../shared/floating-workspace-dock'
import { resolveDraggedBottomDockHeight } from './bottom-dock-resize'

const drag = (startClientY: number, currentClientY: number, startHeight = 300): number =>
  resolveDraggedBottomDockHeight({
    startHeight,
    startClientY,
    currentClientY,
    viewportHeight: 1000
  })

describe('resolveDraggedBottomDockHeight', () => {
  // The sign check that matters: a bottom-anchored panel grows when the pointer goes UP.
  it('grows the dock as the pointer moves up', () => {
    expect(drag(600, 500)).toBe(400)
  })

  it('shrinks the dock as the pointer moves down', () => {
    expect(drag(600, 700)).toBe(200)
  })

  it('holds the height when the pointer has not moved', () => {
    expect(drag(600, 600)).toBe(300)
  })

  it('refuses to shrink past the usable floor', () => {
    expect(drag(600, 5000)).toBe(MIN_FLOATING_WORKSPACE_BOTTOM_HEIGHT)
  })

  // Clamped during the drag, not only on release — otherwise the preview outruns what gets stored
  // and the panel snaps back the moment the pointer lifts.
  it('refuses to grow past the viewport share mid-drag', () => {
    expect(drag(600, -5000)).toBe(1000 * MAX_FLOATING_WORKSPACE_BOTTOM_HEIGHT_RATIO)
  })
})
