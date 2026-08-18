import { clampFloatingWorkspaceBottomHeight } from '../../../shared/floating-workspace-dock'

/**
 * Height a top-edge drag should produce for the bottom dock.
 *
 * The dock is pinned to the bottom, so its height grows as the pointer moves up: the delta is
 * start-minus-current, not the usual current-minus-start. Getting that sign wrong yields a panel
 * that shrinks when you pull it open, which is the kind of bug that survives review because both
 * directions "work".
 *
 * Clamped here rather than at the call site so a drag can never preview a size the store would
 * later refuse to persist — the panel would snap on release.
 */
export function resolveDraggedBottomDockHeight(params: {
  startHeight: number
  startClientY: number
  currentClientY: number
  viewportHeight: number | null | undefined
}): number {
  const { startHeight, startClientY, currentClientY, viewportHeight } = params
  return clampFloatingWorkspaceBottomHeight(
    startHeight + (startClientY - currentClientY),
    viewportHeight
  )
}
