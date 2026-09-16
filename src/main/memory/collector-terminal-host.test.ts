import { beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import type { MemorySnapshotStore } from './collector'

const { appMetricsMock, execMock, listRegisteredPtysMock, listConnectedDaemonPidsMock } =
  vi.hoisted(() => ({
    appMetricsMock: vi.fn(() => [] as unknown[]),
    execMock: vi.fn(),
    listRegisteredPtysMock: vi.fn(() => [] as unknown[]),
    listConnectedDaemonPidsMock: vi.fn(() => [] as number[])
  }))

vi.mock('electron', () => ({ app: { getAppMetrics: appMetricsMock } }))

vi.mock('child_process', () => ({
  exec: (cmd: string, opts: unknown, cb: (err: Error | null, out: { stdout: string }) => void) =>
    execMock(cmd, opts, cb),
  execFile: vi.fn()
}))

vi.mock('./pty-registry', () => ({ listRegisteredPtys: listRegisteredPtysMock }))

vi.mock('./terminal-host-daemon-pids', () => ({
  listConnectedDaemonPids: listConnectedDaemonPidsMock
}))

const store = {
  getWorktreeMeta: () => undefined,
  getRepo: () => undefined
} satisfies MemorySnapshotStore

const MB = 1024 * 1024

// Daemon 500 hosts a ConPTY-style helper 510 and a registered shell 520 (with child 521).
const HOST_TABLE = [
  '1 0 0 1024',
  '500 1 2.0 40960',
  '510 500 0.5 8192',
  '520 500 1.0 20480',
  '521 520 0.0 10240'
].join('\n')

function mockSweep(stdout: string): void {
  execMock.mockImplementation((_cmd, _opts, cb) => cb(null, { stdout, stderr: '' }))
}

async function loadCollector() {
  vi.resetModules()
  return await import('./collector')
}

describe('collectMemorySnapshot terminal host attribution', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // Why: the unix sweep path is deterministic under a mocked exec on every host.
    vi.spyOn(os, 'platform').mockReturnValue('linux')
    appMetricsMock.mockReset().mockReturnValue([])
    execMock.mockReset()
    listRegisteredPtysMock.mockReset().mockReturnValue([])
    listConnectedDaemonPidsMock.mockReset().mockReturnValue([])
  })

  it('counts the connected daemon in the Orca total and its unclaimed descendants separately', async () => {
    mockSweep(HOST_TABLE)
    listConnectedDaemonPidsMock.mockReturnValue([500])
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'p1', worktreeId: 'repo::/w', sessionId: 's1', paneKey: null, pid: 520 }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(store)

    expect(snapshot.app.terminalHost).toEqual({ cpu: 2, memory: 40 * MB })
    expect(snapshot.app.memory).toBe(40 * MB)
    expect(snapshot.terminalHostDescendants).toEqual({ cpu: 0.5, memory: 8 * MB })
    expect(snapshot.worktrees[0].memory).toBe(30 * MB)
    expect(snapshot.totalMemory).toBe(40 * MB + 8 * MB + 30 * MB)
    expect(snapshot.processSweep).toBe('measured')
  })

  it('never lets the daemon walk claim a registered PTY subtree', async () => {
    mockSweep(HOST_TABLE)
    listConnectedDaemonPidsMock.mockReturnValue([500])
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'p1', worktreeId: 'repo::/w', sessionId: 's1', paneKey: null, pid: 521 }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(store)

    // 521 belongs to the PTY; 510 and 520 are unattributed daemon descendants.
    expect(snapshot.worktrees[0].memory).toBe(10 * MB)
    expect(snapshot.terminalHostDescendants?.memory).toBe(8 * MB + 20 * MB)
  })

  it('attributes nothing to the terminal host when no daemon is connected', async () => {
    mockSweep(HOST_TABLE)
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(store)

    expect(snapshot.app.terminalHost).toEqual({ cpu: 0, memory: 0 })
    expect(snapshot.terminalHostDescendants).toEqual({ cpu: 0, memory: 0 })
    expect(snapshot.totalMemory).toBe(0)
    expect(snapshot.processSweep).toBe('measured')
  })

  it('ignores a connected daemon pid the sweep did not list', async () => {
    mockSweep('1 0 0 1024')
    listConnectedDaemonPidsMock.mockReturnValue([500])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(store)

    expect(snapshot.app.terminalHost).toEqual({ cpu: 0, memory: 0 })
  })

  it('marks an empty process sweep as failed rather than a measured idle host', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) => cb(new Error('ps timed out'), null))
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'p1', worktreeId: 'repo::/w', sessionId: 's1', paneKey: null, pid: 520 }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(store)

    expect(snapshot.processSweep).toBe('failed')
  })
})
