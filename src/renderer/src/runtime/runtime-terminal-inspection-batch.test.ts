import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inspectRuntimeTerminalProcesses } from './runtime-terminal-inspection-batch'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { PTY_PROCESS_INSPECTION_BATCH_MAX_IDS } from '../../../shared/pty-process-inspection-batch'

const agent = { foregroundProcess: 'codex', hasChildProcesses: true }

describe('inspectRuntimeTerminalProcesses', () => {
  const runtimeCall = vi.fn()
  const localInspect = vi.fn()
  const localInspectMany = vi.fn()

  function stubWindow(withBatch: boolean): void {
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: (args: RuntimeEnvironmentCallRequest) =>
            createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeCall(args)
        },
        pty: {
          inspectProcess: localInspect,
          ...(withBatch ? { inspectProcesses: localInspectMany } : {})
        }
      }
    })
  }

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    vi.clearAllMocks()
    runtimeCall.mockResolvedValue({
      ok: true,
      result: { process: { foregroundProcess: 'bash', hasChildProcesses: false } },
      _meta: { runtimeId: 'runtime-1' }
    })
    stubWindow(true)
  })

  it('asks main once for every local pane and keeps each answer', async () => {
    // Why reversed: answers are matched by id, never by position.
    localInspectMany.mockImplementation(async (ids: string[]) =>
      ids
        .toReversed()
        .map((id) =>
          id === 'b'
            ? { id, status: 'failed' }
            : { id, status: 'inspected', inspection: { ...agent, foregroundProcess: id } }
        )
    )

    const outcomes = await inspectRuntimeTerminalProcesses(null, ['a', 'b', 'ssh:h@@c', 'a'])

    expect(localInspectMany).toHaveBeenCalledExactlyOnceWith(['a', 'b', 'ssh:h@@c'])
    expect(localInspect).not.toHaveBeenCalled()
    expect(outcomes.get('a')).toEqual({
      status: 'inspected',
      inspection: { ...agent, foregroundProcess: 'a' }
    })
    expect(outcomes.get('b')).toEqual({ status: 'failed' })
    expect(outcomes.get('ssh:h@@c')).toMatchObject({ status: 'inspected' })
  })

  it('never lets an answer for an id it did not ask about land, and fails the unanswered', async () => {
    localInspectMany.mockResolvedValue([
      { id: 'other', status: 'inspected', inspection: agent },
      { id: 'a', status: 'inspected', inspection: agent }
    ])

    const outcomes = await inspectRuntimeTerminalProcesses(null, ['a', 'b'])

    expect([...outcomes.keys()].sort()).toEqual(['a', 'b'])
    expect(outcomes.get('b')).toEqual({ status: 'failed' })
  })

  it('reports every pane of a lost envelope as failed, not idle', async () => {
    localInspectMany.mockRejectedValue(new Error('ipc closed'))

    const outcomes = await inspectRuntimeTerminalProcesses(null, ['a', 'b'])

    expect(outcomes.get('a')).toEqual({ status: 'failed' })
    expect(outcomes.get('b')).toEqual({ status: 'failed' })
  })

  it('splits a large set into bounded envelopes rather than one call per pane', async () => {
    localInspectMany.mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({ id, status: 'inspected', inspection: agent }))
    )
    const ids = Array.from({ length: PTY_PROCESS_INSPECTION_BATCH_MAX_IDS + 1 }, (_, i) => `p${i}`)

    const outcomes = await inspectRuntimeTerminalProcesses(null, ids)

    expect(localInspectMany).toHaveBeenCalledTimes(2)
    expect([...outcomes.values()].every((o) => o.status === 'inspected')).toBe(true)
  })

  it('falls back to one call per pane on a surface without the batch method', async () => {
    stubWindow(false)
    localInspect.mockImplementation(async (id: string) => {
      if (id === 'b') {
        throw new Error('terminal_liveness_unavailable')
      }
      return agent
    })

    const outcomes = await inspectRuntimeTerminalProcesses(null, ['a', 'b'])

    expect(localInspect).toHaveBeenCalledTimes(2)
    expect(outcomes.get('a')).toEqual({ status: 'inspected', inspection: agent })
    expect(outcomes.get('b')).toEqual({ status: 'failed' })
  })

  it('asks a runtime-owned pane its own host, and a failing host fails only its panes', async () => {
    localInspectMany.mockResolvedValue([{ id: 'a', status: 'inspected', inspection: agent }])
    runtimeCall.mockRejectedValue(new Error('environment offline'))

    const outcomes = await inspectRuntimeTerminalProcesses(
      { activeRuntimeEnvironmentId: 'env-2' },
      ['a', 'remote:env-1@@terminal-1']
    )

    expect(localInspectMany).toHaveBeenCalledExactlyOnceWith(['a'])
    expect(outcomes.get('a')).toEqual({ status: 'inspected', inspection: agent })
    expect(outcomes.get('remote:env-1@@terminal-1')).toEqual({ status: 'failed' })
  })
})
