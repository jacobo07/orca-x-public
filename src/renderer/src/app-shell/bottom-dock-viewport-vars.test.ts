import { describe, expect, it } from 'vitest'
import {
  BOTTOM_DOCK_VIEWPORT_VARS,
  applyBottomDockViewportVars,
  resolveBottomDockViewportVars
} from './bottom-dock-viewport-vars'

function styleTarget(): {
  style: CSSStyleDeclaration
  written: Map<string, string>
  removed: string[]
} {
  const written = new Map<string, string>()
  const removed: string[] = []
  const style = {
    setProperty: (name: string, value: string) => {
      written.set(name, value)
    },
    removeProperty: (name: string) => {
      written.delete(name)
      removed.push(name)
    }
  } as unknown as CSSStyleDeclaration
  return { style, written, removed }
}

describe('resolveBottomDockViewportVars', () => {
  it('publishes the measured slot in px', () => {
    expect(resolveBottomDockViewportVars({ left: 260, top: 500, width: 1000, height: 320 })).toEqual(
      {
        [BOTTOM_DOCK_VIEWPORT_VARS.left]: '260px',
        [BOTTOM_DOCK_VIEWPORT_VARS.top]: '500px',
        [BOTTOM_DOCK_VIEWPORT_VARS.width]: '1000px',
        [BOTTOM_DOCK_VIEWPORT_VARS.height]: '320px'
      }
    )
  })

  it('clears every variable when there is no slot', () => {
    expect(resolveBottomDockViewportVars(null)).toEqual({
      [BOTTOM_DOCK_VIEWPORT_VARS.left]: null,
      [BOTTOM_DOCK_VIEWPORT_VARS.top]: null,
      [BOTTOM_DOCK_VIEWPORT_VARS.width]: null,
      [BOTTOM_DOCK_VIEWPORT_VARS.height]: null
    })
  })

  // A mounted-but-unlaid-out slot measures 0x0. Publishing it would pin the panel to an empty box;
  // treating it as absent leaves the panel where it was until a real measurement arrives.
  it('treats a zero-area slot as absent rather than as a real position', () => {
    expect(resolveBottomDockViewportVars({ left: 0, top: 0, width: 0, height: 0 })).toEqual(
      resolveBottomDockViewportVars(null)
    )
    expect(resolveBottomDockViewportVars({ left: 10, top: 10, width: 800, height: 0 })).toEqual(
      resolveBottomDockViewportVars(null)
    )
    expect(resolveBottomDockViewportVars({ left: 10, top: 10, width: 0, height: 300 })).toEqual(
      resolveBottomDockViewportVars(null)
    )
  })
})

describe('applyBottomDockViewportVars', () => {
  it('writes measured values onto the target', () => {
    const target = styleTarget()

    applyBottomDockViewportVars(
      target,
      resolveBottomDockViewportVars({ left: 5, top: 6, width: 7, height: 8 })
    )

    expect(target.written.get(BOTTOM_DOCK_VIEWPORT_VARS.left)).toBe('5px')
    expect(target.written.get(BOTTOM_DOCK_VIEWPORT_VARS.height)).toBe('8px')
  })

  // Removing beats writing an empty string: an empty custom property still shadows the panel's
  // fallback in var(), so the undocked panel would resolve its position to nothing.
  it('removes cleared variables instead of blanking them', () => {
    const target = styleTarget()
    applyBottomDockViewportVars(
      target,
      resolveBottomDockViewportVars({ left: 5, top: 6, width: 7, height: 8 })
    )

    applyBottomDockViewportVars(target, resolveBottomDockViewportVars(null))

    expect(target.written.size).toBe(0)
    expect(target.removed).toContain(BOTTOM_DOCK_VIEWPORT_VARS.left)
    expect(target.removed).toContain(BOTTOM_DOCK_VIEWPORT_VARS.height)
  })

  it('is a no-op without a target', () => {
    expect(() =>
      applyBottomDockViewportVars(null, resolveBottomDockViewportVars(null))
    ).not.toThrow()
  })
})
