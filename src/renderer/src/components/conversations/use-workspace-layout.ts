import { useEffect, useState, type RefObject } from 'react'

/**
 * The workspace's layout from ITS OWN width, not the window's: Orca's side panel, activity rail and
 * split docks all take width first, and a viewport breakpoint would lay three columns into space
 * that holds one (measured: at a 1024px window the chat column reached zero width).
 *
 *   wide    roster | chat, header chips with their words
 *   medium  roster | chat, header chips compact
 *   narrow  roster OR chat, one at a time
 *
 * The agent's context is WorkspaceFrame's column, outside this element; the thresholds keep the
 * chat column widths they had when the 320px rail sat inside it.
 */
export type WorkspaceLayoutMode = 'wide' | 'medium' | 'narrow'

export const WORKSPACE_WIDE_MIN_PX = 800
export const WORKSPACE_MEDIUM_MIN_PX = 760

export function workspaceLayoutModeForWidth(width: number): WorkspaceLayoutMode {
  if (width >= WORKSPACE_WIDE_MIN_PX) {
    return 'wide'
  }
  return width >= WORKSPACE_MEDIUM_MIN_PX ? 'medium' : 'narrow'
}

export function useWorkspaceLayoutMode(ref: RefObject<HTMLElement | null>): WorkspaceLayoutMode {
  const [mode, setMode] = useState<WorkspaceLayoutMode>('wide')
  useEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }
    const apply = (width: number): void => setMode(workspaceLayoutModeForWidth(width))
    apply(element.getBoundingClientRect().width)
    // Event-driven, not a poll: fires only when the element's box changes.
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1)
      if (entry) {
        apply(entry.contentRect.width)
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return mode
}
