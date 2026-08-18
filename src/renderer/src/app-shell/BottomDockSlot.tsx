import { useLayoutEffect, useRef } from 'react'
import {
  applyBottomDockViewportVars,
  resolveBottomDockViewportVars
} from './bottom-dock-viewport-vars'

/**
 * In-flow reservation for the bottom-docked workspace.
 *
 * It renders nothing visible: its whole job is to take the dock's height out of the content
 * column — so the editor shrinks instead of being covered — and to publish its own measured rect
 * so the viewport-fixed panel can sit exactly on top of it.
 */
export function BottomDockSlot({ height }: { height: number }): React.JSX.Element {
  const slotRef = useRef<HTMLDivElement | null>(null)

  // Layout effect, not an effect: the panel positions from these variables, so publishing after
  // paint would show it at its previous rect for a frame on every relayout.
  useLayoutEffect(() => {
    const node = slotRef.current
    if (!node) {
      return
    }
    const publish = (): void => {
      const rect = node.getBoundingClientRect()
      applyBottomDockViewportVars(
        document.documentElement,
        resolveBottomDockViewportVars({
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        })
      )
    }
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(node)
    // Why the parent and the root too: the slot's own box does not change when the column above it
    // gains or loses a titlebar, yet its top does. Size-only observation would leave the panel
    // pinned to a stale line across that reflow.
    if (node.parentElement) {
      observer.observe(node.parentElement)
    }
    observer.observe(document.documentElement)
    return () => {
      observer.disconnect()
      // Clear on unmount so an undocked or closed panel cannot keep positioning itself from the
      // last measured rect.
      applyBottomDockViewportVars(document.documentElement, resolveBottomDockViewportVars(null))
    }
  }, [])

  return <div ref={slotRef} aria-hidden className="shrink-0" style={{ height }} />
}
