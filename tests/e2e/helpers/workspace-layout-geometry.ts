import type { Page } from '@stablyai/playwright-test'

/**
 * Measures the Workspace's horizontal column boundaries from the rendered app.
 *
 * Why measured rather than reasoned from CSS: the left column takes the max-content width of
 * its widest child, and that child's width depends on translated menu labels. Only the running
 * app knows the real number.
 */

export type WorkspaceColumnGeometry = {
  /** Projects sidebar; null when collapsed. */
  projectSidebar: { left: number; right: number; width: number } | null
  /** Terminal workbench column. */
  workbench: { left: number; right: number; width: number } | null
  /** The `.titlebar-left` header that shares the left column with the sidebar. */
  leftHeader: { left: number; right: number; width: number } | null
  /**
   * Pixels between the sidebar's right edge and the workbench's left edge. Anything past a
   * border is geometry no surface paints.
   */
  gapPx: number | null
  /** Application-menu labels currently rendered in the strip; empty when collapsed to the button. */
  menuStripLabels: string[]
  /** Natural width the menu strip wants, independent of whether it currently fits. */
  menuStripScrollWidth: number | null
  /**
   * Whether the compact menu button the strip falls back to is rendered. Detected by class,
   * not by accessible name: the name is translated, so an English selector reports a Spanish
   * build as having no menu at all.
   */
  compactMenuButtonPresent: boolean
}

const PROJECT_SIDEBAR_SELECTOR = '[data-native-file-drop-target="project-sidebar"]'
const WORKBENCH_SELECTOR = '[data-terminal-workbench-container]'

export async function measureWorkspaceColumns(page: Page): Promise<WorkspaceColumnGeometry> {
  return page.evaluate(
    ({ sidebarSelector, workbenchSelector }) => {
      const measure = (
        selector: string
      ): { left: number; right: number; width: number } | null => {
        const el = document.querySelector(selector)
        if (!el) {
          return null
        }
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) {
          return null
        }
        return {
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width)
        }
      }
      const projectSidebar = measure(sidebarSelector)
      const workbench = measure(workbenchSelector)
      const menuButtons = Array.from(document.querySelectorAll('.titlebar-menu-strip-button'))
      const stripParent = menuButtons[0]?.parentElement ?? null
      return {
        projectSidebar,
        workbench,
        leftHeader: measure('.titlebar-left'),
        gapPx:
          projectSidebar && workbench ? Math.round(workbench.left - projectSidebar.right) : null,
        menuStripLabels: menuButtons.map((button) => (button.textContent ?? '').trim()),
        menuStripScrollWidth: stripParent ? Math.round(stripParent.scrollWidth) : null,
        compactMenuButtonPresent:
          document.querySelector('.titlebar-left .titlebar-icon-button') !== null
      }
    },
    { sidebarSelector: PROJECT_SIDEBAR_SELECTOR, workbenchSelector: WORKBENCH_SELECTOR }
  )
}
