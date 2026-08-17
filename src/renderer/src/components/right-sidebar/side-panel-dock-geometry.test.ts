import { describe, expect, it } from 'vitest'
import { resolveSidePanelDockGeometry } from './side-panel-dock-geometry'

// Why this file: docking the panel left mirrors six independent decisions. Getting any one of
// them wrong is silent — the panel still renders, it just resizes backwards, loses its seam, or
// carries padding for a window overlay on the opposite side of the screen.
describe('resolveSidePanelDockGeometry', () => {
  it('flips the resize direction so dragging inward always grows the panel', () => {
    expect(resolveSidePanelDockGeometry('left').resizeDeltaSign).toBe(1)
    expect(resolveSidePanelDockGeometry('right').resizeDeltaSign).toBe(-1)
  })

  it('puts the resize handle on the inward-facing edge, opposite the docked window edge', () => {
    expect(resolveSidePanelDockGeometry('left').resizeHandleEdgeClass).toBe('right-0')
    expect(resolveSidePanelDockGeometry('right').resizeHandleEdgeClass).toBe('left-0')
  })

  it('draws the content seam on the inward-facing side', () => {
    expect(resolveSidePanelDockGeometry('left').panelBorderSide).toBe('borderRight')
    expect(resolveSidePanelDockGeometry('right').panelBorderSide).toBe('borderLeft')
  })

  it('keeps the activity bar hugging the window edge in both DOM order and border side', () => {
    const left = resolveSidePanelDockGeometry('left')
    expect(left.activityBarLeads).toBe(true)
    expect(left.activityBarBorderClass).toBe('border-r')

    const right = resolveSidePanelDockGeometry('right')
    expect(right.activityBarLeads).toBe(false)
    expect(right.activityBarBorderClass).toBe('border-l')
  })

  it('drops window-controls insets when docked left', () => {
    // The overlay is fixed to the top-right of the window. Applying its inset to a left-docked
    // panel reserves 138px of padding against nothing and forces the split-row Windows layout.
    expect(resolveSidePanelDockGeometry('left').appliesWindowControlsInset).toBe(false)
    expect(resolveSidePanelDockGeometry('right').appliesWindowControlsInset).toBe(true)
  })

  it('never returns the same geometry for both docks', () => {
    // Guards against a future refactor collapsing the branch and silently disabling the mirror.
    expect(resolveSidePanelDockGeometry('left')).not.toEqual(resolveSidePanelDockGeometry('right'))
  })
})
