import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from './types'
import { inspectPtyProcessesForRenderer } from './pty-process-inspection-batch'
import { PTY_PROCESS_INSPECTION_BATCH_MAX_IDS } from '../../shared/pty-process-inspection-batch'

type Behaviour = 'agent' | 'shell' | 'gone' | 'throws' | 'hangs'

function providerFor(behaviours: Record<string, Behaviour>) {
  const inspectProcess = vi.fn(async (id: string) => {
    switch (behaviours[id]) {
      case 'agent':
        return { foregroundProcess: 'codex', hasChildProcesses: true }
      case 'shell':
        return { foregroundProcess: 'pwsh', hasChildProcesses: false }
      case 'gone':
        throw new Error('terminal_gone')
      case 'hangs':
        return new Promise<never>(() => {})
      default:
        throw new Error('socket closed')
    }
  })
  const provider = { inspectProcess } as unknown as IPtyProvider
  return { provider, inspectProcess }
}

describe('inspectPtyProcessesForRenderer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers every pane separately, keyed by id, whatever the others did', async () => {
    vi.useFakeTimers()
    const { provider } = providerFor({
      a: 'agent',
      b: 'shell',
      c: 'gone',
      d: 'throws',
      e: 'hangs'
    })
    const pending = inspectPtyProcessesForRenderer(['e', 'd', 'c', 'b', 'a'], () => provider, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    const byId = new Map((await pending).map((entry) => [entry.id, entry]))

    expect(byId.get('a')).toEqual({
      id: 'a',
      status: 'inspected',
      inspection: { foregroundProcess: 'codex', hasChildProcesses: true }
    })
    expect(byId.get('b')).toMatchObject({ status: 'inspected' })
    // A vanished terminal is a known answer, not a failure.
    expect(byId.get('c')).toEqual({
      id: 'c',
      status: 'inspected',
      inspection: { foregroundProcess: null, hasChildProcesses: false, unavailable: true }
    })
    // Neither a thrown nor a hung inspection may read as an idle shell.
    expect(byId.get('d')).toEqual({ id: 'd', status: 'failed' })
    expect(byId.get('e')).toEqual({ id: 'e', status: 'failed' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('asks each provider once per distinct pane and caps the envelope', async () => {
    const behaviours: Record<string, Behaviour> = {}
    const ids = Array.from({ length: PTY_PROCESS_INSPECTION_BATCH_MAX_IDS + 5 }, (_, i) => {
      behaviours[`p${i}`] = 'agent'
      return `p${i}`
    })
    const { provider, inspectProcess } = providerFor(behaviours)

    const entries = await inspectPtyProcessesForRenderer([...ids, 'p0', 7, null], () => provider)

    expect(entries).toHaveLength(PTY_PROCESS_INSPECTION_BATCH_MAX_IDS)
    expect(inspectProcess).toHaveBeenCalledTimes(PTY_PROCESS_INSPECTION_BATCH_MAX_IDS)
  })

  it('fails only the pane whose provider cannot be resolved', async () => {
    const { provider } = providerFor({ a: 'agent' })
    const entries = await inspectPtyProcessesForRenderer(['a', 'missing'], (id) => {
      if (id === 'missing') {
        throw new Error('no provider')
      }
      return provider
    })

    expect(entries).toEqual([
      expect.objectContaining({ id: 'a', status: 'inspected' }),
      { id: 'missing', status: 'failed' }
    ])
  })

  it('answers nothing for a malformed request', async () => {
    const { provider } = providerFor({})
    await expect(inspectPtyProcessesForRenderer('a', () => provider)).resolves.toEqual([])
  })
})
