import { useCallback, useRef, useState } from 'react'
import { useAppStore } from '../../store'

/**
 * Drag-to-resize for the rail's left edge.
 *
 * Pointer capture rather than window listeners: a drag that leaves the window still belongs to the
 * handle it started on, and releasing outside must still end it. The store clamps the width it is
 * given, so nothing here needs to know the limits.
 */
export function useTerminalRailResize(): {
  onResizeHandlePointerDown: (event: React.PointerEvent<HTMLElement>) => void
  isResizing: boolean
} {
  const setTerminalRailWidth = useAppStore((s) => s.setTerminalRailWidth)
  const [isResizing, setIsResizing] = useState(false)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const onResizeHandlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return
      }
      event.preventDefault()
      const handle = event.currentTarget
      handle.setPointerCapture(event.pointerId)
      dragRef.current = { startX: event.clientX, startWidth: useAppStore.getState().terminalRailWidth }
      setIsResizing(true)

      const onMove = (moveEvent: PointerEvent): void => {
        const drag = dragRef.current
        if (!drag) {
          return
        }
        // The rail sits at the right edge, so dragging left widens it.
        setTerminalRailWidth(drag.startWidth + (drag.startX - moveEvent.clientX))
      }
      const onEnd = (): void => {
        dragRef.current = null
        setIsResizing(false)
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onEnd)
        handle.removeEventListener('pointercancel', onEnd)
      }
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onEnd)
      handle.addEventListener('pointercancel', onEnd)
    },
    [setTerminalRailWidth]
  )

  return { onResizeHandlePointerDown, isResizing }
}
