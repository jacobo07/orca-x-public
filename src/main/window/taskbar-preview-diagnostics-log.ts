/**
 * An opt-in record of what the shell asked for and what it was given.
 *
 * Proving a thumbnail stays *current* is a claim about a sequence of events inside a minimized
 * window, which is exactly the state in which no UI can report anything. So the evidence has to
 * leave the process, and it does so only when a path is named in the environment — off by default,
 * because a running Orca should not write a file nobody asked for.
 *
 * What can be written is bounded by the diagnostic type itself: sizes, decisions, counters and
 * HRESULTs. A thumbnail is a picture of whatever is on the user's screen, which routinely includes
 * secrets, and none of it reaches this file — not because the writer filters it, but because the
 * events never carry it.
 */
import { appendFileSync } from 'node:fs'

import type { TaskbarPreviewAttachDiagnostic } from './attach-taskbar-preview'

export type TaskbarPreviewLoggedEvent = TaskbarPreviewAttachDiagnostic

export const TASKBAR_PREVIEW_LOG_ENV = 'ORCA_TASKBAR_PREVIEW_LOG'

export function createTaskbarPreviewDiagnosticsLog(args: {
  path?: string
  windowLabel: string
  now?: () => number
  append?: (path: string, line: string) => void
}): ((event: TaskbarPreviewLoggedEvent) => void) | undefined {
  const path = args.path
  if (!path) {
    return undefined
  }
  const now = args.now ?? (() => Date.now())
  const append = args.append ?? ((target, line) => appendFileSync(target, line))
  return (event) => {
    try {
      append(path, `${JSON.stringify({ at: now(), window: args.windowLabel, ...event })}\n`)
    } catch {
      // Diagnostics are not the product. An unwritable path must not take a window down with it.
    }
  }
}
