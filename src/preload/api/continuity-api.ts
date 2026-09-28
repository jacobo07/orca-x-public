import type {
  DeskReadResult,
  PanePreviewRequest,
  PanePreviewResult,
  WakeAdmissionRequest,
  WakeAdmissionResult
} from '../../shared/desk-continuity-read-types'

/** The previous desk as the desktop's owners already keep it. Reading it wakes nothing. */
export type ContinuityApi = {
  continuity: {
    readDesk: () => Promise<DeskReadResult>
    /** A pane's last recorded screen, rendered from durable history. Always a snapshot, never live. */
    renderPanePreview: (request: PanePreviewRequest) => Promise<PanePreviewResult>
    /** Whether one more session may wake now on that workspace's host. Starts nothing. */
    admitWake: (request: WakeAdmissionRequest) => Promise<WakeAdmissionResult>
  }
}
