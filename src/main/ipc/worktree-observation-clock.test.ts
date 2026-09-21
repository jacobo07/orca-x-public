import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWorktreeObservationClock,
  WORKTREE_OBSERVATION_ACTIVE_WINDOW_MS,
  WORKTREE_OBSERVATION_QUIET_EVERY_CYCLES,
  type WorktreeObservationRunResult
} from './worktree-observation-clock'

const INTERVAL = 1_000

function countingRun(result: WorktreeObservationRunResult = 'observed') {
  const calls: boolean[] = []
  const run = vi.fn(async (force: boolean) => {
    calls.push(force)
    return result
  })
  return { run, calls }
}

async function cycles(count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await vi.advanceTimersByTimeAsync(INTERVAL)
  }
}

describe('worktree observation clock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('arms one timer for many targets and releases it after the last one leaves', async () => {
    const clock = createWorktreeObservationClock(INTERVAL)
    expect(vi.getTimerCount()).toBe(0)
    const targets = Array.from({ length: 20 }, () => countingRun())
    const registrations = targets.map((target) => clock.register(target.run))
    expect(vi.getTimerCount()).toBe(1)

    await cycles(3)
    for (const target of targets) {
      expect(target.run).toHaveBeenCalledTimes(3)
    }
    expect(vi.getTimerCount()).toBe(1)

    for (const registration of registrations) {
      registration.unregister()
    }
    expect(clock.inspect()).toMatchObject({ registrations: 0, running: false })
    expect(vi.getTimerCount()).toBe(0)
    await cycles(3)
    expect(targets[0].run).toHaveBeenCalledTimes(3)
  })

  it('runs quiet targets once per quiet period and active ones every cycle', async () => {
    const clock = createWorktreeObservationClock(INTERVAL)
    const quiet = countingRun()
    const active = countingRun()
    const pinned = countingRun()
    clock.register(quiet.run)
    const activeRegistration = clock.register(active.run)
    clock.register(pinned.run, { isPinnedActive: () => true })

    vi.setSystemTime(Date.now() + WORKTREE_OBSERVATION_ACTIVE_WINDOW_MS + 1)
    activeRegistration.noteActivity()
    const period = WORKTREE_OBSERVATION_QUIET_EVERY_CYCLES * 4
    await cycles(period)

    expect(quiet.run).toHaveBeenCalledTimes(4)
    expect(active.run).toHaveBeenCalledTimes(period)
    expect(pinned.run).toHaveBeenCalledTimes(period)
  })

  it('returns a quiet target to the full cadence as soon as it reports activity', async () => {
    const clock = createWorktreeObservationClock(INTERVAL)
    const target = countingRun()
    const registration = clock.register(target.run)
    vi.setSystemTime(Date.now() + WORKTREE_OBSERVATION_ACTIVE_WINDOW_MS + 1)
    await cycles(WORKTREE_OBSERVATION_QUIET_EVERY_CYCLES)
    const quietRuns = target.run.mock.calls.length
    expect(quietRuns).toBe(1)

    registration.noteActivity()
    await cycles(4)
    expect(target.run).toHaveBeenCalledTimes(quietRuns + 4)
  })

  it('never overlaps a slow target with itself and replays a forced request after it', async () => {
    const clock = createWorktreeObservationClock(INTERVAL)
    let active = 0
    let maxActive = 0
    const forced: boolean[] = []
    let release: () => void = () => {}
    const registration = clock.register(async (force) => {
      forced.push(force)
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolve) => {
        release = resolve
      })
      active--
      return 'observed'
    })

    await cycles(3)
    registration.runNow(true)
    expect(forced).toEqual([false])
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(maxActive).toBe(1)
    expect(forced).toEqual([false, true])
  })

  it('bounds concurrent runs and releases a hung run so others keep observing', async () => {
    const clock = createWorktreeObservationClock(INTERVAL, 2)
    let active = 0
    let maxActive = 0
    const hung = vi.fn(() => new Promise<WorktreeObservationRunResult>(() => {}))
    clock.register(hung)
    clock.register(hung)
    const healthy = countingRun()
    const slow = Array.from({ length: 4 }, () =>
      clock.register(async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active--
        return 'observed'
      })
    )
    clock.register(healthy.run)

    await cycles(10)
    expect(hung).toHaveBeenCalledTimes(2)
    expect(healthy.run.mock.calls.length).toBeGreaterThan(0)
    expect(maxActive).toBeLessThanOrEqual(2)
    expect(slow).toHaveLength(4)
  })

  it('keeps observing the others when one target throws', async () => {
    const clock = createWorktreeObservationClock(INTERVAL)
    const failing = vi.fn(async () => {
      throw new Error('stat exploded')
    })
    const healthy = countingRun()
    clock.register(failing)
    clock.register(healthy.run)
    await cycles(3)
    expect(failing).toHaveBeenCalledTimes(3)
    expect(healthy.run).toHaveBeenCalledTimes(3)
  })

  it('stops the timer while every target is parked and resumes on runNow', async () => {
    const clock = createWorktreeObservationClock(INTERVAL)
    let hidden = true
    const run = vi.fn(async () => (hidden ? 'parked' : 'observed') as WorktreeObservationRunResult)
    const registration = clock.register(run)
    await cycles(1)
    expect(clock.inspect()).toMatchObject({ parked: 1, running: false })
    await cycles(5)
    expect(run).toHaveBeenCalledTimes(1)

    hidden = false
    registration.runNow(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenLastCalledWith(true)
    expect(clock.inspect().running).toBe(true)
    await cycles(2)
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('does not run a target that unregistered while queued', async () => {
    const clock = createWorktreeObservationClock(INTERVAL, 1)
    let release: () => void = () => {}
    clock.register(
      () =>
        new Promise<WorktreeObservationRunResult>((resolve) => {
          release = () => resolve('observed')
        })
    )
    const queued = countingRun()
    const registration = clock.register(queued.run)
    await cycles(1)
    registration.unregister()
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(queued.run).not.toHaveBeenCalled()
  })
})
