import { describe, expect, it, vi } from 'vitest'
import type { ParkPhaseResult } from '../../shared/durable-exit-types'
import { createParkCoordinator, type ParkCoordinatorDeps } from './park-coordinator'

const parked: ParkPhaseResult = {
  status: 'parked',
  workspaces: [{ worktreeId: 'wt', outcome: 'slept', livePtyCount: 2 }],
  alreadyAsleepCount: 0,
  sleptTabIds: ['tab-1', 'tab-2']
}

function deps(overrides: Partial<ParkCoordinatorDeps> = {}) {
  let id = 0
  const base: ParkCoordinatorDeps = {
    countWindows: () => 1,
    runRendererPhase: vi.fn(async () => parked),
    checkSleptTabsSaved: vi.fn(async () => ({ ok: true as const })),
    scheduleQuit: vi.fn(),
    newOperationId: () => `op-${++id}`
  }
  return { ...base, ...overrides }
}

const park = { mode: 'park', includePinned: false } as const

describe('createParkCoordinator', () => {
  it('exits only after the saved session proves every slept tab', async () => {
    const d = deps()
    const result = await createParkCoordinator(d).park(park)
    expect(d.checkSleptTabsSaved).toHaveBeenCalledWith(['tab-1', 'tab-2'])
    expect(result).toMatchObject({ operationId: 'op-1', status: 'parked', exiting: true })
    expect(result).not.toHaveProperty('sleptTabIds')
    expect(d.scheduleQuit).toHaveBeenCalledOnce()
  })

  it('stays open when the disk does not hold what the window said it saved', async () => {
    const d = deps({
      checkSleptTabsSaved: vi.fn(async () => ({ ok: false as const, detail: 'missing' }))
    })
    const result = await createParkCoordinator(d).park(park)
    expect(result).toMatchObject({ status: 'seal-failed', exiting: false, detail: 'missing' })
    expect(d.scheduleQuit).not.toHaveBeenCalled()
  })

  it.each(['refused', 'incomplete', 'seal-failed'] as const)(
    'stays open on %s without checking the disk',
    async (status) => {
      const d = deps({ runRendererPhase: vi.fn(async () => ({ ...parked, status })) })
      const result = await createParkCoordinator(d).park(park)
      expect(result).toMatchObject({ status, exiting: false })
      expect(d.checkSleptTabsSaved).not.toHaveBeenCalled()
      expect(d.scheduleQuit).not.toHaveBeenCalled()
    }
  )

  it('never exits for a plan, even one that found nothing to keep', async () => {
    const d = deps({
      runRendererPhase: vi.fn(async () => ({ ...parked, status: 'planned' as const }))
    })
    const result = await createParkCoordinator(d).park({ mode: 'plan', includePinned: false })
    expect(result.exiting).toBe(false)
    expect(d.scheduleQuit).not.toHaveBeenCalled()
  })

  it.each([
    [0, 'no-window'],
    [2, 'multiple-windows']
  ])('is unavailable with %i windows and asks nobody', async (count, detail) => {
    const d = deps({ countWindows: () => count })
    const result = await createParkCoordinator(d).park(park)
    expect(result).toMatchObject({ status: 'unavailable', detail, exiting: false })
    expect(d.runRendererPhase).not.toHaveBeenCalled()
  })

  it('reports a window that did not answer as unavailable', async () => {
    const d = deps({
      runRendererPhase: vi.fn(async (): Promise<never> => {
        throw new Error('renderer_timeout')
      })
    })
    const result = await createParkCoordinator(d).park(park)
    expect(result).toMatchObject({ status: 'unavailable', detail: 'renderer_timeout' })
  })

  it('joins a second caller to the park already running, and quits once', async () => {
    let finish: (value: ParkPhaseResult) => void = () => {}
    const d = deps({
      runRendererPhase: vi.fn(
        () =>
          new Promise<ParkPhaseResult>((resolve) => {
            finish = resolve
          })
      )
    })
    const coordinator = createParkCoordinator(d)
    const first = coordinator.park(park)
    const second = coordinator.park({ mode: 'park', includePinned: true })
    finish(parked)
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(d.runRendererPhase).toHaveBeenCalledOnce()
    expect(d.scheduleQuit).toHaveBeenCalledOnce()
  })

  it('starts a new park once the previous one settled', async () => {
    const d = deps({
      runRendererPhase: vi.fn(async () => ({ ...parked, status: 'refused' as const }))
    })
    const coordinator = createParkCoordinator(d)
    await coordinator.park(park)
    await coordinator.park(park)
    expect(d.runRendererPhase).toHaveBeenCalledTimes(2)
  })
})
