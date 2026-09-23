import { describe, expect, it } from 'vitest'
import type { HostMemory } from '../../../shared/process-stats-types'
import { observeDispatchHostResources } from './dispatch-host-observation'

const NOW = new Date('2026-09-22T12:00:00.000Z')

export function hostMemory(overrides: Partial<HostMemory> = {}): HostMemory {
  return {
    totalMemory: 32 * 1024 ** 3,
    freeMemory: 4 * 1024 ** 3,
    availableMemory: 8 * 1024 ** 3,
    availableMemorySource: 'proc-meminfo',
    usedMemory: 24 * 1024 ** 3,
    memoryUsagePercent: 75,
    cpuCoreCount: 20,
    loadAverage1m: 1.75,
    ...overrides
  }
}

const collect = (memory = hostMemory()) => async () => memory

describe('observeDispatchHostResources', () => {
  it('reads this host when the worker runs on it, carrying the source through', async () => {
    const result = await observeDispatchHostResources(
      { kind: 'local', hostId: 'local' },
      'term_a',
      collect(hostMemory({ availableMemory: 9 * 1024 ** 3, availableMemorySource: 'free-memory' })),
      () => NOW
    )
    expect(result).toEqual({
      kind: 'observed',
      observation: {
        availableMemoryBytes: 9 * 1024 ** 3,
        source: 'free-memory',
        observedAt: NOW.toISOString()
      }
    })
  })

  it('will not answer for an ssh worker with this host numbers', async () => {
    const result = await observeDispatchHostResources(
      { kind: 'ssh', targetId: 'gex44' },
      'term_ssh',
      collect(),
      () => NOW
    )
    expect(result).toMatchObject({ kind: 'unobservable', cause: 'executor-not-local' })
    expect(result.kind === 'unobservable' && result.detail).toContain('gex44')
  })

  // hostId is 'local' and the memory domain is not: a WSL2 distro has its own budget, so this
  // host's reading OVERSTATES what the worker can have -- the direction this must not fail in.
  it('will not answer for a WSL worker either, despite hostId being local', async () => {
    const result = await observeDispatchHostResources(
      { kind: 'wsl', hostId: 'local', distro: 'Ubuntu-22.04' },
      'term_wsl',
      collect(),
      () => NOW
    )
    expect(result).toMatchObject({ kind: 'unobservable', cause: 'executor-not-local' })
    expect(result.kind === 'unobservable' && result.detail).toContain('Ubuntu-22.04')
  })

  it('keeps which-host-is-this apart from the-reading-failed', async () => {
    const unknown = await observeDispatchHostResources(null, 'term_gone', collect(), () => NOW)
    expect(unknown).toMatchObject({ kind: 'unobservable', cause: 'executor-unknown' })

    const failed = await observeDispatchHostResources(
      { kind: 'local', hostId: 'local' },
      'term_a',
      async () => {
        throw new Error('meminfo unreadable')
      },
      () => NOW
    )
    expect(failed).toMatchObject({ kind: 'unavailable' })
    expect(failed.kind === 'unavailable' && failed.detail).toContain('meminfo unreadable')
  })
})
