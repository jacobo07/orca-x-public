/**
 * The bottom-docked workspace is a viewport-fixed overlay, so it cannot inherit the content
 * column's position from the tree. The shell instead reserves an in-flow slot whose rect IS the
 * dock's footprint and publishes it as CSS variables; the panel positions itself onto them.
 *
 * Why the rect rather than recomputed layout math: the slot already sits after the sidebar, the
 * side panel and the titlebar, so its measured box accounts for all of them. Deriving the same
 * box from widths would duplicate the layout rules and drift the moment one of them changes.
 */
export const BOTTOM_DOCK_VIEWPORT_VARS = {
  left: '--floating-workspace-dock-left',
  top: '--floating-workspace-dock-top',
  width: '--floating-workspace-dock-width',
  height: '--floating-workspace-dock-height'
} as const

export type BottomDockRect = {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Map a measured slot to its CSS variable values. `null` clears every variable, which is what an
 * undocked or closed panel publishes so a stale rect can never keep positioning it.
 *
 * A zero-area rect is treated as absent: it means the slot is mounted but not laid out yet, and
 * pinning the panel to a 0×0 box would collapse it rather than leave it where it was.
 */
export function resolveBottomDockViewportVars(
  rect: BottomDockRect | null
): Record<string, string | null> {
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return {
      [BOTTOM_DOCK_VIEWPORT_VARS.left]: null,
      [BOTTOM_DOCK_VIEWPORT_VARS.top]: null,
      [BOTTOM_DOCK_VIEWPORT_VARS.width]: null,
      [BOTTOM_DOCK_VIEWPORT_VARS.height]: null
    }
  }
  return {
    [BOTTOM_DOCK_VIEWPORT_VARS.left]: `${rect.left}px`,
    [BOTTOM_DOCK_VIEWPORT_VARS.top]: `${rect.top}px`,
    [BOTTOM_DOCK_VIEWPORT_VARS.width]: `${rect.width}px`,
    [BOTTOM_DOCK_VIEWPORT_VARS.height]: `${rect.height}px`
  }
}

/** Apply resolved variables to a style target; `null` removes rather than writing an empty string. */
export function applyBottomDockViewportVars(
  target: { style: CSSStyleDeclaration } | null,
  vars: Record<string, string | null>
): void {
  if (!target) {
    return
  }
  for (const [name, value] of Object.entries(vars)) {
    if (value === null) {
      target.style.removeProperty(name)
      continue
    }
    target.style.setProperty(name, value)
  }
}
