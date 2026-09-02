/**
 * Any workspace window still worth notifying.
 *
 * Several process-wide services captured a window at the moment they started: directory watchers,
 * upgrade polls, sync contexts. The window was only ever "who to answer to", but with one window it
 * was indistinguishable from "whether anyone is listening" — so its death correctly meant stop. With
 * a second window that equivalence breaks, and the survivor is left holding services that idle,
 * park or drop every event on the way out.
 *
 * The resolver is injected by the host rather than imported from the window registry, so these
 * modules keep no opinion about what an app window is and stay testable without Electron. Nothing
 * set means no survivor, which is the single-window behaviour unchanged.
 */
import type { BrowserWindow } from 'electron'

let resolve: (() => BrowserWindow | null) | null = null

export function setSurvivingAppWindowResolver(
  resolveSurvivor: (() => BrowserWindow | null) | null
): void {
  resolve = resolveSurvivor
}

/** A live window to fall back to, or null when nothing is listening any more. */
export function survivingAppWindow(): BrowserWindow | null {
  const survivor = resolve?.() ?? null
  return survivor && !survivor.isDestroyed() ? survivor : null
}
