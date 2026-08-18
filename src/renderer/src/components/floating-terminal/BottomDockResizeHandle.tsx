import { useCallback, useRef } from 'react'
import { resolveDraggedBottomDockHeight } from '@/app-shell/bottom-dock-resize'
import { useAppStore } from '@/store'

/**
 * The bottom dock's only resize affordance: its top edge.
 *
 * The floating handles are not reused here because they move a free rect in four directions,
 * while a docked panel has three edges it cannot leave.
 */
export function BottomDockResizeHandle(): React.JSX.Element {
  const height = useAppStore((s) => s.floatingWorkspaceBottomHeight)
  const previewHeight = useAppStore((s) => s.previewFloatingWorkspaceBottomHeight)
  const commitHeight = useAppStore((s) => s.setFloatingWorkspaceBottomHeight)
  // Start height is captured on pointer-down rather than read live: reading the current height each
  // move compounds the delta against a value the previous move already changed, which accelerates
  // the panel away from the pointer.
  const dragRef = useRef<{ pointerId: number; startClientY: number; startHeight: number } | null>(
    null
  )

  const resolveHeight = useCallback((clientY: number): number | null => {
    const drag = dragRef.current
    if (!drag) {
      return null
    }
    return resolveDraggedBottomDockHeight({
      startHeight: drag.startHeight,
      startClientY: drag.startClientY,
      currentClientY: clientY,
      viewportHeight: typeof window === 'undefined' ? null : window.innerHeight
    })
  }, [])

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      dragRef.current = {
        pointerId: event.pointerId,
        startClientY: event.clientY,
        startHeight: height
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
    },
    [height]
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const next = resolveHeight(event.clientY)
      if (next !== null) {
        previewHeight(next)
      }
    },
    [previewHeight, resolveHeight]
  )

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const next = resolveHeight(event.clientY)
      dragRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      // Commit the last resolved size, not the live store value: a cancel can arrive before the
      // final move is applied, and persisting the store would then save a height the user
      // never released on.
      commitHeight(next ?? height)
    },
    [commitHeight, height, resolveHeight]
  )

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      data-floating-terminal-no-drag
      // Sits above the panel's own top border and overhangs it slightly, so the grab target is
      // reachable without hunting for a 1px line.
      className="absolute inset-x-0 -top-1 z-10 h-2 cursor-ns-resize"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  )
}
