import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { ParkRequest, ParkResult } from '../../shared/durable-exit-types'
import {
  createParkCoordinator,
  installParkCoordinator,
  type ParkCoordinator
} from '../durable-exit/park-coordinator'
import { requestParkPhaseFromRenderer } from '../durable-exit/park-renderer-relay'
import { checkSleptTabsSaved } from '../durable-exit/park-saved-session-check'
import { listWorkspaceWindows } from '../window/workspace-window-registry'

// Why a delay: the CLI and the menu receive the result before the app goes away.
const QUIT_AFTER_RESULT_MS = 500

function openWorkspaceWindows(): BrowserWindow[] {
  return listWorkspaceWindows()
    .map((record) => BrowserWindow.fromId(record.browserWindowId))
    .filter((window): window is BrowserWindow => Boolean(window && !window.isDestroyed()))
}

/** Anything else is refused: a malformed request must not become a park. */
export function parseParkRequest(value: unknown): ParkRequest | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const { mode, includePinned } = value as Record<string, unknown>
  if ((mode !== 'plan' && mode !== 'park') || typeof includePinned !== 'boolean') {
    return null
  }
  return { mode, includePinned }
}

export function createDesktopParkCoordinator(getDataFile: () => string): ParkCoordinator {
  return createParkCoordinator({
    countWindows: () => openWorkspaceWindows().length,
    runRendererPhase: (request) => {
      const [window] = openWorkspaceWindows()
      if (!window) {
        return Promise.reject(new Error('no-window'))
      }
      return requestParkPhaseFromRenderer(window, request)
    },
    checkSleptTabsSaved: (tabIds) => checkSleptTabsSaved(getDataFile(), tabIds),
    scheduleQuit: () => {
      setTimeout(() => app.quit(), QUIT_AFTER_RESULT_MS)
    },
    newOperationId: () => randomUUID()
  })
}

export function registerDurableExitHandlers(getDataFile: () => string): void {
  const coordinator = createDesktopParkCoordinator(getDataFile)
  installParkCoordinator(coordinator)
  ipcMain.removeHandler('durableExit:park')
  ipcMain.handle('durableExit:park', (_event, value: unknown): Promise<ParkResult> => {
    const request = parseParkRequest(value)
    if (!request) {
      return Promise.resolve({
        operationId: randomUUID(),
        status: 'unavailable',
        workspaces: [],
        alreadyAsleepCount: 0,
        exiting: false,
        detail: 'invalid-request'
      })
    }
    return coordinator.park(request)
  })
}
