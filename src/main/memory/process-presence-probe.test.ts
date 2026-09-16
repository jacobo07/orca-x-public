import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppMetrics: () => [] } }))
vi.mock('./process-memory-metric', () => ({ getProcessMemoryMetric: () => 'working-set' }))

import type { ProcIndex } from './collector'
import { probeProcessPresence } from './process-presence-probe'

function indexOf(pids: number[]): ProcIndex {
  return {
    byPid: new Map(pids.map((pid) => [pid, { pid, ppid: 1, cpu: 0, memory: 1 }])),
    childrenOf: new Map()
  }
}

describe('probeProcessPresence', () => {
  it('lists only the asked pids that the sweep still sees', async () => {
    const before = Date.now()
    const probe = await probeProcessPresence([10, 11, 12], async () => indexOf([1, 11]))
    expect(probe).toMatchObject({ sweep: 'measured', metric: 'working-set', presentPids: [11] })
    expect(probe.sweepStartedAt).toBeGreaterThanOrEqual(before)
  })

  // Why: the enumerators swallow errors and return []; that must not read as "all gone".
  it('reports an empty sweep as failed, not as every pid absent', async () => {
    const probe = await probeProcessPresence([10], async () => indexOf([]))
    expect(probe.sweep).toBe('failed')
    expect(probe).not.toHaveProperty('presentPids')
  })

  it('reports a thrown sweep as failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const probe = await probeProcessPresence([10], async () => {
      throw new Error('boom')
    })
    expect(probe.sweep).toBe('failed')
  })

  it('stamps the start before the sweep runs, so a slow sweep cannot look later', async () => {
    let startedAt = 0
    const probe = await probeProcessPresence([10], async () => {
      startedAt = Date.now()
      await new Promise((resolve) => setTimeout(resolve, 20))
      return indexOf([1])
    })
    expect(probe.sweepStartedAt).toBeLessThanOrEqual(startedAt)
  })
})
