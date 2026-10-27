import type { PaneSessionResumeResult } from '@/lib/pane-session-resume-intent'

type ResumeHandler = () => Promise<PaneSessionResumeResult>

// Why module scope: each window is its own renderer, so this is already per window, and a pane
// key names one pane — no surface ever routes by focus or by the newest window.
const handlers = new Map<string, ResumeHandler>()
const inFlight = new Map<string, Promise<PaneSessionResumeResult>>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** The mounted pane that owns `paneKey` offers its canonical resume; returns the unregister. */
export function registerPaneSessionResumeHandler(
  paneKey: string,
  handler: ResumeHandler
): () => void {
  handlers.set(paneKey, handler)
  notify()
  return () => {
    if (handlers.get(paneKey) === handler) {
      handlers.delete(paneKey)
      notify()
    }
  }
}

export function hasPaneSessionResumeHandler(paneKey: string): boolean {
  return handlers.has(paneKey)
}

export function isPaneSessionResumeInFlight(paneKey: string): boolean {
  return inFlight.has(paneKey)
}

/**
 * Resume the exact session `paneKey` exited from, through the pane's own handler. Every surface
 * shares one attempt per pane: a second click joins it instead of spawning a second provider.
 */
export function requestPaneSessionResume(paneKey: string): Promise<PaneSessionResumeResult> {
  const pending = inFlight.get(paneKey)
  if (pending) {
    return pending
  }
  const handler = handlers.get(paneKey)
  if (!handler) {
    return Promise.resolve({ outcome: 'unavailable', capability: { kind: 'hidden' } })
  }
  const attempt = handler()
    .catch((): PaneSessionResumeResult => ({ outcome: 'spawn-failed' }))
    .finally(() => {
      inFlight.delete(paneKey)
      notify()
    })
  inFlight.set(paneKey, attempt)
  notify()
  return attempt
}

/** For `useSyncExternalStore`: fires when a handler or an in-flight attempt comes or goes. */
export function subscribePaneSessionResumeDispatch(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
