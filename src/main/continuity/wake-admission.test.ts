import { describe, expect, it, vi } from 'vitest'
import type { HostMemory } from '../../shared/process-stats-types'
import { decideWakeAdmission, PROVISIONAL_WAKE_FLOOR_BYTES } from './wake-admission'
import { withE2EWakeReading } from './wake-admission-e2e-reading'

const GB = 1000 ** 3

function reading(availableMemory: number): HostMemory {
  return {
    totalMemory: 32 * GB,
    freeMemory: availableMemory,
    availableMemory,
    availableMemorySource: 'free-memory',
    usedMemory: 32 * GB - availableMemory,
    memoryUsagePercent: 50,
    cpuCoreCount: 8
  } as HostMemory
}

function deps(available: number, path: string | null = '/repos/app') {
  return {
    workspacePath: vi.fn(() => path),
    collectHostMemory: vi.fn(async () => reading(available)),
    now: () => new Date('2026-09-28T12:00:00Z')
  }
}

describe('decideWakeAdmission', () => {
  it('admits a local wake while the host holds at least the floor', async () => {
    const d = deps(PROVISIONAL_WAKE_FLOOR_BYTES + 1)
    await expect(
      decideWakeAdmission({ hostId: 'local', workspaceKey: 'wt-1' }, d)
    ).resolves.toEqual({
      verdict: 'admitted',
      availableMemoryBytes: PROVISIONAL_WAKE_FLOOR_BYTES + 1,
      floorBytes: PROVISIONAL_WAKE_FLOOR_BYTES
    })
    expect(d.collectHostMemory).toHaveBeenCalledTimes(1)
  })

  it('refuses a local wake below the floor, naming the reason', async () => {
    const result = await decideWakeAdmission(
      { hostId: 'local', workspaceKey: 'wt-1' },
      deps(PROVISIONAL_WAKE_FLOOR_BYTES - 1)
    )
    expect(result).toMatchObject({ verdict: 'refused', reason: 'insufficient-available-memory' })
  })

  it('refuses a WSL workspace as unobservable and never reads the Windows host for it', async () => {
    const d = deps(64 * GB, '\\\\wsl.localhost\\Ubuntu\\home\\me\\app')
    const result = await decideWakeAdmission({ hostId: 'local', workspaceKey: 'wt-1' }, d)
    expect(result).toMatchObject({ verdict: 'refused', reason: 'executor-unobservable' })
    expect(d.collectHostMemory).not.toHaveBeenCalled()
  })

  it('refuses ssh and runtime hosts as not measured', async () => {
    for (const hostId of ['ssh:box-1', 'runtime:env-1']) {
      const d = deps(64 * GB)
      await expect(decideWakeAdmission({ hostId, workspaceKey: 'wt-1' }, d)).resolves.toMatchObject(
        { verdict: 'refused', reason: 'executor-unobservable' }
      )
      expect(d.collectHostMemory).not.toHaveBeenCalled()
    }
  })

  it('refuses when the reading fails, rather than admitting on no evidence', async () => {
    const d = deps(64 * GB)
    d.collectHostMemory.mockRejectedValueOnce(new Error('sweep failed'))
    await expect(
      decideWakeAdmission({ hostId: 'local', workspaceKey: 'wt-1' }, d)
    ).resolves.toMatchObject({ verdict: 'refused', reason: 'observation-unavailable' })
  })

  it('refuses a malformed request or an unknown host id', async () => {
    for (const request of [null, { hostId: 'local' }, { hostId: 'nope:x', workspaceKey: 'wt-1' }]) {
      await expect(decideWakeAdmission(request, deps(64 * GB))).resolves.toMatchObject({
        verdict: 'refused',
        reason: 'invalid-request'
      })
    }
  })

  it('resolves the path from main, ignoring any path the caller sends', async () => {
    const d = deps(64 * GB, '/repos/app')
    await decideWakeAdmission(
      { hostId: 'local', workspaceKey: 'wt-1', path: '\\\\wsl.localhost\\Ubuntu\\x' },
      d
    )
    expect(d.workspacePath).toHaveBeenCalledWith('wt-1', 'local')
    expect(d.collectHostMemory).toHaveBeenCalledTimes(1)
  })
})

describe('withE2EWakeReading', () => {
  it('is inert outside an e2e profile', () => {
    const collect = async (): Promise<HostMemory> => reading(1)
    expect(withE2EWakeReading(collect, { ORCA_E2E_WAKE_AVAILABLE_BYTES: '1,2' })).toBe(collect)
  })

  it('replays the scripted figures in order and repeats the last one', async () => {
    const read = withE2EWakeReading(async () => reading(99), {
      ORCA_E2E_USER_DATA_DIR: '/tmp/x',
      ORCA_E2E_WAKE_AVAILABLE_BYTES: '5000000000, 100'
    })
    const figures = [
      (await read()).availableMemory,
      (await read()).availableMemory,
      (await read()).availableMemory
    ]
    expect(figures).toEqual([5_000_000_000, 100, 100])
  })
})
