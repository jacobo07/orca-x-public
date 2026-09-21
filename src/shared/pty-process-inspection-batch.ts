import type { PtyProcessInspection } from './pty-process-inspection'

// Why per id: one envelope carries many panes, and each keeps its own truth.
// 'failed' means nothing is known about that pane; it is never evidence of an exit.
export type PtyProcessInspectionBatchEntry =
  | { id: string; status: 'inspected'; inspection: PtyProcessInspection }
  | { id: string; status: 'failed' }

export const PTY_PROCESS_INSPECTION_BATCH_MAX_IDS = 64
