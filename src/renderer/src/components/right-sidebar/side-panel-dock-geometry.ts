import type { SidePanelDock } from '../../../../shared/ui-chrome-types'

export type SidePanelDockGeometry = {
  /** Drag direction that grows the panel: the handle always faces away from the docked window edge. */
  resizeDeltaSign: 1 | -1
  /** Tailwind edge class placing the resize handle on the panel's inward-facing side. */
  resizeHandleEdgeClass: 'left-0' | 'right-0'
  /** Which side carries the seam against the content area. */
  panelBorderSide: 'borderLeft' | 'borderRight'
  /** Tailwind border class for the activity-bar icon strip, which always hugs the window edge. */
  activityBarBorderClass: 'border-l' | 'border-r'
  /** Whether the icon strip leads the panel in DOM order (true when it hugs the left window edge). */
  activityBarLeads: boolean
  /**
   * Whether window-controls insets apply. They reserve room for the fixed top-RIGHT overlay
   * (138x36 on custom desktop chrome), so a left-docked panel that never sits under it must
   * drop them or it gains phantom padding and a needless second icon row.
   */
  appliesWindowControlsInset: boolean
}

export function resolveSidePanelDockGeometry(dock: SidePanelDock): SidePanelDockGeometry {
  if (dock === 'left') {
    return {
      resizeDeltaSign: 1,
      resizeHandleEdgeClass: 'right-0',
      panelBorderSide: 'borderRight',
      activityBarBorderClass: 'border-r',
      activityBarLeads: true,
      appliesWindowControlsInset: false
    }
  }

  return {
    resizeDeltaSign: -1,
    resizeHandleEdgeClass: 'left-0',
    panelBorderSide: 'borderLeft',
    activityBarBorderClass: 'border-l',
    activityBarLeads: false,
    appliesWindowControlsInset: true
  }
}
