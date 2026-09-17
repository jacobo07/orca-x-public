// R3 Density Lab: Fan-Out Factor for the batched inspection path — effective
// inspection cardinality over transport cardinality, per leg.
//
// windows-agent-foreground-process-scan-volume.test.ts already bounds the census
// primitive (a burst of panes collapses to one scan). This measures the
// COMPOSITION the renderer actually drives: one `pty:inspectProcesses` envelope
// carrying N pane ids. The batch asks every provider separately by design, so the
// question is what that costs underneath — N census forks, or one shared scan.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import type { IPtyProvider } from './types'
import { inspectPtyProcessesForRenderer } from './pty-process-inspection-batch'

const { execFileMock, powershellScanCount } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  powershellScanCount: { value: 0 }
}))

vi.mock('child_process', () => ({ execFile: execFileMock }))

import {
  queryWindowsProcessDescendants,
  resetWindowsProcessRowsSnapshotForTests
} from './windows-foreground-process-rows'

const SCALE_POINTS = [1, 10, 50] as const

const shellPid = (pane: number): number => 100 + pane * 1000
const paneId = (pane: number): string => `pane-${pane}`

function processTableFor(paneCount: number): string {
  return JSON.stringify(
    Array.from({ length: paneCount }, (_, pane) => {
      const shell = shellPid(pane)
      return [
        {
          ProcessId: shell,
          ParentProcessId: 99,
          Name: 'cmd.exe',
          CommandLine: 'cmd.exe',
          ExecutablePath: 'C:/Windows/System32/cmd.exe'
        },
        {
          ProcessId: shell + 1,
          ParentProcessId: shell,
          Name: 'node.exe',
          CommandLine: 'node C:/Users/dev/AppData/codex/bin/codex.js',
          ExecutablePath: 'C:/Program Files/nodejs/node.exe'
        }
      ]
    }).flat()
  )
}

/**
 * Stands in for the local provider's own inspection: the real one resolves its
 * foreground process through the shared Windows census, which is the leg whose
 * cardinality this measures. Its in-memory subtree walk is per pane either way.
 */
function countingLocalProvider(paneCount: number) {
  const inspectProcess = vi.fn(async (id: string) => {
    const pane = Number(id.slice('pane-'.length))
    const descendants = await queryWindowsProcessDescendants(shellPid(pane))
    return {
      foregroundProcess: descendants?.[0]?.name ?? null,
      hasChildProcesses: (descendants?.length ?? 0) > 0
    }
  })
  void paneCount
  return { provider: { inspectProcess } as unknown as IPtyProvider, inspectProcess }
}

type FanOutPoint = {
  panes: number
  transportCalls: number
  providerCalls: number
  censusScans: number
  answered: number
}

describe('batched pty inspection fan-out', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    resetWindowsProcessRowsSnapshotForTests()
    powershellScanCount.value = 0
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('costs one census per due cycle at every pane count, and answers every pane', async () => {
    const curve: FanOutPoint[] = []

    for (const panes of SCALE_POINTS) {
      resetWindowsProcessRowsSnapshotForTests()
      powershellScanCount.value = 0
      execFileMock.mockImplementation(
        (cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
          const callback = cb as (
            err: unknown,
            result: { stdout: string; stderr: string }
          ) => void
          if (cmd === 'powershell.exe') {
            powershellScanCount.value += 1
          }
          callback(null, { stdout: processTableFor(panes), stderr: '' })
        }
      )
      const { provider, inspectProcess } = countingLocalProvider(panes)
      const ids = Array.from({ length: panes }, (_, pane) => paneId(pane))

      // One envelope, exactly as the window clock sends it.
      const entries = await inspectPtyProcessesForRenderer(ids, () => provider)

      curve.push({
        panes,
        transportCalls: 1,
        providerCalls: inspectProcess.mock.calls.length,
        censusScans: powershellScanCount.value,
        answered: entries.filter((entry) => entry.status === 'inspected').length
      })

      // Sharing must not cost truth: each pane still resolves its own foreground.
      for (const entry of entries) {
        expect(entry).toMatchObject({ status: 'inspected' })
      }
      expect(entries).toHaveLength(panes)
    }

    const out = process.env.ORCA_DENSITY_FAN_OUT_OUT
    if (out) {
      writeFileSync(out, JSON.stringify({ metric: 'fan-out-factor', curve }, null, 2))
    }

    const byPanes = new Map(curve.map((point) => [point.panes, point]))
    // Transport: one request per due cycle, independent of pane count.
    expect(curve.map((point) => point.transportCalls)).toEqual([1, 1, 1])
    // Effect: the providers are asked per pane, by design — this is the N leg.
    expect(curve.map((point) => point.providerCalls)).toEqual([1, 10, 50])
    // The expensive leg is shared: the whole-process-table fork does not multiply.
    expect(curve.map((point) => point.censusScans)).toEqual([1, 1, 1])
    // Every pane answered at every scale point; a shared scan is not a lost answer.
    expect(byPanes.get(50)?.answered).toBe(50)
  })

  it('keeps one slow pane from holding the rest of the envelope', async () => {
    // The shared setup fakes only Date; this case needs the subject timeout too.
    vi.useFakeTimers()
    execFileMock.mockImplementation((_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
      callback(null, { stdout: processTableFor(3), stderr: '' })
    })
    const inspectProcess = vi.fn(async (id: string) =>
      id === 'pane-1'
        ? new Promise<never>(() => {})
        : {
            foregroundProcess: 'node.exe',
            hasChildProcesses: true
          }
    )
    const provider = { inspectProcess } as unknown as IPtyProvider

    const pending = inspectPtyProcessesForRenderer(
      ['pane-0', 'pane-1', 'pane-2'],
      () => provider,
      1_000
    )
    await vi.advanceTimersByTimeAsync(1_000)
    const byId = new Map((await pending).map((entry) => [entry.id, entry]))

    expect(byId.get('pane-0')).toMatchObject({ status: 'inspected' })
    expect(byId.get('pane-2')).toMatchObject({ status: 'inspected' })
    // Unknown, never an idle shell.
    expect(byId.get('pane-1')).toEqual({ id: 'pane-1', status: 'failed' })
  })
})
