import type { ParkPhaseResult, ParkRequest, ParkResult } from '../../shared/durable-exit-types'

export type ParkSaveCheck = { ok: true } | { ok: false; detail: string }

export type ParkCoordinatorDeps = {
  /** Windows that could run the park. Only a single window holds the whole workspace state. */
  countWindows: () => number
  runRendererPhase: (request: ParkRequest) => Promise<ParkPhaseResult>
  /** Reads the saved session back from disk; every listed tab must be there and dormant. */
  checkSleptTabsSaved: (tabIds: readonly string[]) => Promise<ParkSaveCheck>
  /** Quits through the normal path, after the caller has had its answer. */
  scheduleQuit: () => void
  newOperationId: () => string
}

export type ParkCoordinator = {
  park: (request: ParkRequest) => Promise<ParkResult>
}

function emptyResult(
  operationId: string,
  status: ParkResult['status'],
  detail: string
): ParkResult {
  return { operationId, status, workspaces: [], alreadyAsleepCount: 0, exiting: false, detail }
}

/**
 * The one park authority: every caller (menu, CLI) goes through here. It never destroys anything
 * itself — the window's workspace Sleep does, and the daemon retires itself on the normal quit once
 * it holds no session. See docs/reference/durable-park-and-exit.md.
 */
export function createParkCoordinator(deps: ParkCoordinatorDeps): ParkCoordinator {
  let inFlight: Promise<ParkResult> | null = null

  async function run(request: ParkRequest): Promise<ParkResult> {
    const operationId = deps.newOperationId()
    const windows = deps.countWindows()
    if (windows !== 1) {
      return emptyResult(
        operationId,
        'unavailable',
        windows === 0 ? 'no-window' : 'multiple-windows'
      )
    }
    let phase: ParkPhaseResult
    try {
      phase = await deps.runRendererPhase(request)
    } catch (error) {
      return emptyResult(
        operationId,
        'unavailable',
        error instanceof Error ? error.message : String(error)
      )
    }
    const { sleptTabIds, ...rest } = phase
    const result: ParkResult = { operationId, ...rest, exiting: false }
    if (
      request.mode !== 'park' ||
      (rest.status !== 'parked' && rest.status !== 'nothing-to-park')
    ) {
      return result
    }
    // Why: the window said it saved; the exit relies on what the disk says.
    const saved = await deps
      .checkSleptTabsSaved(sleptTabIds)
      .catch((error: unknown): ParkSaveCheck => ({ ok: false, detail: String(error) }))
    if (!saved.ok) {
      return { ...result, status: 'seal-failed', detail: saved.detail }
    }
    return { ...result, exiting: true }
  }

  return {
    park(request) {
      // Why: a second caller joins the running park rather than starting another.
      if (!inFlight) {
        inFlight = run(request)
          .then((result) => {
            if (result.exiting) {
              deps.scheduleQuit()
            }
            return result
          })
          .finally(() => {
            inFlight = null
          })
      }
      return inFlight
    }
  }
}

let installed: ParkCoordinator | null = null

export function installParkCoordinator(coordinator: ParkCoordinator | null): void {
  installed = coordinator
}

export function getParkCoordinator(): ParkCoordinator | null {
  return installed
}
