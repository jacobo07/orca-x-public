/**
 * Wires one window's renderer-liveness observations into the breadcrumb lane.
 *
 * The subscriptions are passed in rather than read off a BrowserWindow so the recording contract
 * is testable without Electron: what matters here is which event produces which record, and that
 * is exactly the part a real window cannot be asked about in a unit test.
 */
import type { BrowserWindow } from 'electron'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { createRendererLivenessWatch, type ScheduledSettle } from './renderer-liveness-watch'

export type RendererLivenessSubscriptions = {
  onUnresponsive: (listener: () => void) => void
  onResponsive: (listener: () => void) => void
  onRendererProcessGone: (listener: () => void) => void
  onClosed: (listener: () => void) => void
}

export type RendererLivenessRecorderDeps = {
  windowId: number
  webContentsId: number
  subscriptions: RendererLivenessSubscriptions
  now?: () => number
  record?: (name: string, data: Record<string, string | number | boolean | null>) => void
  schedule?: (run: () => void, delayMs: number) => ScheduledSettle
}

function scheduleUnrefTimer(run: () => void, delayMs: number): ScheduledSettle {
  const timer = setTimeout(run, delayMs)
  // Why: a pending liveness record must never keep a quitting app alive.
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

export function recordRendererLiveness(deps: RendererLivenessRecorderDeps): void {
  const record = deps.record ?? recordDurableCrashBreadcrumb
  const identity = { windowId: deps.windowId, webContentsId: deps.webContentsId }
  const watch = createRendererLivenessWatch({
    now: deps.now ?? (() => Date.now()),
    schedule: deps.schedule ?? scheduleUnrefTimer,
    onObservation: (observation) => {
      if (observation.kind === 'unresponsive') {
        record('renderer_unresponsive', identity)
        return
      }
      if (observation.kind === 'responsive') {
        record('renderer_responsive', {
          ...identity,
          unresponsiveMs: observation.unresponsiveMs
        })
        return
      }
      // Why its own name: this is the shape the user reports, and a search that cannot separate it
      // from a stall that cleared cannot answer whether the freeze was ever survivable.
      record('renderer_unresponsive_abandoned', {
        ...identity,
        unresponsiveMs: observation.unresponsiveMs,
        reason: observation.reason
      })
    }
  })

  deps.subscriptions.onUnresponsive(() => watch.markUnresponsive())
  deps.subscriptions.onResponsive(() => watch.markResponsive())
  deps.subscriptions.onRendererProcessGone(() => watch.markGone('process-gone'))
  deps.subscriptions.onClosed(() => watch.markGone('closed'))
}

export function attachRendererLivenessWatch(window: BrowserWindow): void {
  const webContents = window.webContents
  recordRendererLiveness({
    windowId: window.id,
    webContentsId: webContents.id,
    subscriptions: {
      onUnresponsive: (listener) => {
        window.on('unresponsive', listener)
      },
      onResponsive: (listener) => {
        window.on('responsive', listener)
      },
      onRendererProcessGone: (listener) => {
        webContents.on('render-process-gone', listener)
      },
      onClosed: (listener) => {
        window.on('closed', listener)
      }
    }
  })
}
