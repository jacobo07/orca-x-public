import type {
  DeskReadResult,
  PanePreviewRequest,
  PanePreviewResult
} from '../../shared/desk-continuity-read-types'

/** The previous desk as the desktop's owners already keep it. Reading it wakes nothing. */
export type ContinuityApi = {
  continuity: {
    readDesk: () => Promise<DeskReadResult>
    /** A pane's last recorded screen, rendered from durable history. Always a snapshot, never live. */
    renderPanePreview: (request: PanePreviewRequest) => Promise<PanePreviewResult>
  }
}
