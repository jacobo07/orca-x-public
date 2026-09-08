import { describe, expect, it } from 'vitest'
import { PtyViewerWindowRegistry } from './pty-viewer-window-registry'

const WINDOW_A = 1
const WINDOW_B = 2

describe('PtyViewerWindowRegistry', () => {
  it('reports a pty as unknown until a renderer claims it either way', () => {
    // Arrange
    const registry = new PtyViewerWindowRegistry()

    // Act / Assert — never claimed, so main has nothing to conclude.
    expect(registry.isKnown('pty-1')).toBe(false)
  })

  it('treats a pty claimed visible by a presentable window as presentable', () => {
    // Arrange
    const registry = new PtyViewerWindowRegistry()

    // Act
    registry.setViewerVisibility('pty-1', WINDOW_A, true)

    // Assert
    expect(registry.isKnown('pty-1')).toBe(true)
    expect(registry.hasPresentableViewer('pty-1')).toBe(true)
  })

  it('treats a pty every window has hidden as not presentable', () => {
    const registry = new PtyViewerWindowRegistry()

    registry.setViewerVisibility('pty-1', WINDOW_A, true)
    registry.setViewerVisibility('pty-1', WINDOW_A, false)

    expect(registry.isKnown('pty-1')).toBe(true)
    expect(registry.hasPresentableViewer('pty-1')).toBe(false)
  })

  // The defect this registry exists for: the renderer reports which PANE is showing a pty, which
  // stays true when the OS minimizes the whole window. Minimized is the one state where the app
  // believes the pane is on screen and the renderer cannot draw or drain it.
  it('stops treating a visible pane as presentable once its window is minimized', () => {
    const registry = new PtyViewerWindowRegistry()
    registry.setViewerVisibility('pty-1', WINDOW_A, true)

    registry.setWindowPresentable(WINDOW_A, false)

    expect(registry.hasPresentableViewer('pty-1')).toBe(false)
  })

  it('restores presentability when the window comes back', () => {
    const registry = new PtyViewerWindowRegistry()
    registry.setViewerVisibility('pty-1', WINDOW_A, true)
    registry.setWindowPresentable(WINDOW_A, false)

    registry.setWindowPresentable(WINDOW_A, true)

    expect(registry.hasPresentableViewer('pty-1')).toBe(true)
  })

  // Minimizing one window must not background another window's work. A process-global visibility
  // flag cannot express this, which is why the claim is keyed by the window that made it.
  it('keeps a pty presentable while any other window still shows it', () => {
    const registry = new PtyViewerWindowRegistry()
    registry.setViewerVisibility('pty-1', WINDOW_A, true)
    registry.setViewerVisibility('pty-1', WINDOW_B, true)

    registry.setWindowPresentable(WINDOW_A, false)

    expect(registry.hasPresentableViewer('pty-1')).toBe(true)
  })

  it('does not let one window minimizing disturb a pty only the other window shows', () => {
    const registry = new PtyViewerWindowRegistry()
    registry.setViewerVisibility('pty-a', WINDOW_A, true)
    registry.setViewerVisibility('pty-b', WINDOW_B, true)

    registry.setWindowPresentable(WINDOW_A, false)

    expect(registry.hasPresentableViewer('pty-a')).toBe(false)
    expect(registry.hasPresentableViewer('pty-b')).toBe(true)
  })

  it('names the ptys a window claims so a minimize can resync exactly those', () => {
    const registry = new PtyViewerWindowRegistry()
    registry.setViewerVisibility('pty-a', WINDOW_A, true)
    registry.setViewerVisibility('pty-b', WINDOW_A, false)
    registry.setViewerVisibility('pty-c', WINDOW_B, true)

    // Hidden claims are included: a hidden pane in a minimized window still needs re-evaluating
    // when the window returns, and omitting it would leave main's view of it stale.
    expect(new Set(registry.ptyIdsClaimedByWindow(WINDOW_A))).toEqual(new Set(['pty-a', 'pty-b']))
  })

  it('drops a closed window claims so a dead window cannot pin a pty presentable forever', () => {
    const registry = new PtyViewerWindowRegistry()
    registry.setViewerVisibility('pty-1', WINDOW_A, true)
    registry.setViewerVisibility('pty-1', WINDOW_B, true)

    registry.forgetWindow(WINDOW_B)

    expect(registry.hasPresentableViewer('pty-1')).toBe(true)

    registry.forgetWindow(WINDOW_A)

    // Every claim is gone, so main knows nothing about it again rather than assuming hidden.
    expect(registry.isKnown('pty-1')).toBe(false)
    expect(registry.hasPresentableViewer('pty-1')).toBe(false)
  })

  // Fail-safe direction: an unheard-of window is assumed able to present. Guessing the other way
  // would background a pty whose window is on screen, which is output loss rather than a saving.
  it('assumes a window it was never told about can present', () => {
    const registry = new PtyViewerWindowRegistry()

    registry.setViewerVisibility('pty-1', 99, true)

    expect(registry.hasPresentableViewer('pty-1')).toBe(true)
  })

  it('applies a minimize recorded before the renderer claimed anything', () => {
    const registry = new PtyViewerWindowRegistry()

    registry.setWindowPresentable(WINDOW_A, false)
    registry.setViewerVisibility('pty-1', WINDOW_A, true)

    expect(registry.hasPresentableViewer('pty-1')).toBe(false)
  })

  it('forgets a window presentability along with its claims', () => {
    const registry = new PtyViewerWindowRegistry()
    registry.setWindowPresentable(WINDOW_A, false)

    registry.forgetWindow(WINDOW_A)
    registry.setViewerVisibility('pty-1', WINDOW_A, true)

    expect(registry.hasPresentableViewer('pty-1')).toBe(true)
  })
})
