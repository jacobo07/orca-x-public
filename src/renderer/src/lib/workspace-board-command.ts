import { TOGGLE_WORKSPACE_BOARD_EVENT } from '@/components/sidebar/useWorkspaceBoardPanel'
import { revealProjectSidebar, type ProjectSidebarRevealState } from './left-navigation-surface'

/** The board lives in the project sidebar, so the shortcut and the menu both reveal it first. */
export function openWorkspaceBoard(state: ProjectSidebarRevealState): void {
  revealProjectSidebar(state)
  window.dispatchEvent(new CustomEvent(TOGGLE_WORKSPACE_BOARD_EVENT))
}
