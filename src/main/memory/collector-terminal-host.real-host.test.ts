/*
 * Real OS process sweep, no mocked child_process: the test process stands in for the daemon and a
 * spawned child stands in for a ConPTY host. Proves attribution against real rows, not fixtures.
 * Does not cover the daemon connection (see daemon-pty-adapter-connected-identity.test.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppMetrics: () => [] } }))
vi.mock('./pty-registry', () => ({ listRegisteredPtys: () => [] }))
vi.mock('./terminal-host-daemon-pids', () => ({ listConnectedDaemonPids: () => [process.pid] }))

const { collectMemorySnapshot } = await import('./collector')

const store = { getWorktreeMeta: () => undefined, getRepo: () => undefined }

describe('terminal host attribution against the real process table', () => {
  let child: ChildProcess | null = null

  afterEach(() => {
    child?.kill()
    child = null
  })

  it('measures the host process and its unclaimed child', { timeout: 30_000 }, async () => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await new Promise((resolve) => setTimeout(resolve, 500))

    const snapshot = await collectMemorySnapshot(store)

    // A failed sweep here means the host could not answer, not that attribution is wrong.
    expect(snapshot.processSweep, 'host process sweep failed; rerun with more headroom').toBe(
      'measured'
    )
    expect(snapshot.app.terminalHost?.memory).toBeGreaterThan(10 * 1024 * 1024)
    expect(snapshot.terminalHostDescendants?.memory).toBeGreaterThan(1024 * 1024)
    expect(snapshot.totalMemory).toBe(
      (snapshot.app.terminalHost?.memory ?? 0) + (snapshot.terminalHostDescendants?.memory ?? 0)
    )
  })
})
