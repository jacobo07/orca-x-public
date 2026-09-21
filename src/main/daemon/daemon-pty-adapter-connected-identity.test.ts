/* Resource attribution may only use a daemon identity while its authenticated connection is open. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonServer } from './daemon-server'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'

describe('DaemonPtyAdapter.getConnectedDaemonIdentity', () => {
  let dir: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => createMockSubprocess())
    dir = harness.dir
    server = harness.server
    adapter = harness.adapter
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is null before the first connection', () => {
    expect(adapter.getConnectedDaemonIdentity()).toBeNull()
  })

  it('reports the authenticated identity while connected and forgets it on disconnect', async () => {
    await adapter.spawn({ cols: 80, rows: 24 })
    const connected = adapter.getConnectedDaemonIdentity()
    expect(connected?.pid).toBeGreaterThan(0)
    expect(connected?.pid).toBe(adapter.getLastAuthenticatedDaemonIdentity()?.pid)

    await server.shutdown()
    await waitFor(() => adapter.getConnectedDaemonIdentity() === null)

    // The remembered identity survives, which is exactly why attribution must not read it.
    expect(adapter.getLastAuthenticatedDaemonIdentity()?.pid).toBe(connected?.pid)
  })
})
