import { useEffect } from 'react'

// Open layers own their keys (TaskPage's guard list, plus any dialog).
const LAYER_SELECTOR =
  '[data-slot="dropdown-menu-content"], [data-slot="popover-content"], [data-slot="select-content"], [role="menu"], [role="dialog"]'

// A terminal and the inline edit form handle their own Escape and letters.
const OWNS_KEYS_SELECTOR = '.xterm, [data-backlog-edit-form]'

function isEditable(target: HTMLElement): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  )
}

/**
 * Page-scoped keys while Backlog is mounted: bare N opens capture, Esc closes the page. One
 * capture-phase listener, removed on unmount; it never fires inside an input, a terminal or a layer.
 */
export function useBacklogPageKeys({
  onCapture,
  onClose,
  captureOpen
}: {
  onCapture: () => void
  onClose: () => void
  captureOpen: boolean
}): void {
  useEffect(() => {
    if (captureOpen) {
      return undefined
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (!target || document.querySelector(LAYER_SELECTOR) || target.closest(OWNS_KEYS_SELECTOR)) {
        return
      }
      if (event.key === 'Escape') {
        if (isEditable(target)) {
          // Blur only: the field's own handler still runs (search clears itself).
          target.blur()
          return
        }
        event.preventDefault()
        onClose()
        return
      }
      const bare = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      if (
        (event.key === 'n' || event.key === 'N') &&
        bare &&
        !event.isComposing &&
        !event.repeat &&
        !isEditable(target)
      ) {
        event.preventDefault()
        onCapture()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [captureOpen, onCapture, onClose])
}
