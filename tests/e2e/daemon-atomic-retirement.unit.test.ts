import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { requestAtomicRetirement } from '../../src/main/daemon/daemon-atomic-retirement'
import { DaemonPtyAdapter } from '../../src/main/daemon/daemon-pty-adapter'
import {
  createDaemonGenerationRuntime,
  launchDaemonGeneration,
  type DaemonGeneration,
  type DaemonGenerationRuntime
} from './helpers/daemon-generation-safety-fixtures'
import {
  processIdentityIsAlive,
  recordProcessTree,
  terminateRecordedTree,
  type RecordedProcessIdentity
} from './helpers/daemon-generation-processes'

/**
 * The authority a replacing client cannot hold itself.
 *
 * Deliberately narrow: it drives the retirement request against a real daemon and never enters
 * killStaleDaemon, so it spawns no Windows process-identity query. That query needs a subprocess
 * within a 3s budget and misses it when the host is short of memory, which turns the end-to-end
 * gate inconclusive for reasons that say nothing about this contract.
 */
const PROTOCOL_VERSION_UNDER_TEST = 1
const WORKTREE_ID = 'orca-w1b-window'

let runtime: DaemonGenerationRuntime
const ownedIdentities: RecordedProcessIdentity[] = []
const openAdapters: DaemonPtyAdapter[] = []

function openClient(generation: DaemonGeneration): DaemonPtyAdapter {
  const adapter = new DaemonPtyAdapter({
    socketPath: generation.socketPath,
    tokenPath: generation.tokenPath,
    protocolVersion: generation.protocolVersion
  })
  openAdapters.push(adapter)
  return adapter
}

function admitSession(client: DaemonPtyAdapter, label: string): Promise<{ pid?: number }> {
  return client.spawn({
    sessionId: `${WORKTREE_ID}@@orca-w1b-${label}-${randomUUID().slice(0, 8)}`,
    isNewSession: true,
    cols: 80,
    rows: 24,
    cwd: runtime.rootDir,
    ...(process.platform === 'win32' ? { shellOverride: 'cmd.exe' } : {})
  })
}

async function launchOwnedDaemon(label: string): Promise<DaemonGeneration> {
  const generation = await launchDaemonGeneration({
    runtime,
    label,
    protocolVersion: PROTOCOL_VERSION_UNDER_TEST
  })
  ownedIdentities.push(...(await recordProcessTree(generation.identity)))
  return generation
}

function retire(generation: DaemonGeneration): ReturnType<typeof requestAtomicRetirement> {
  return requestAtomicRetirement(
    generation.socketPath,
    generation.tokenPath,
    generation.protocolVersion
  )
}

beforeAll(async () => {
  runtime = await createDaemonGenerationRuntime(null)
}, 120_000)

afterEach(async () => {
  for (const adapter of openAdapters.splice(0)) {
    await adapter.disconnectOnly().catch(() => {})
    adapter.dispose()
  }
  await terminateRecordedTree(ownedIdentities.splice(0))
}, 60_000)

afterAll(() => {
  runtime?.remove()
})

describe('a daemon is the only party that can prove it owns no live work', () => {
  it('retires an empty daemon on request', async () => {
    const generation = await launchOwnedDaemon('empty')

    // Why this is the negative control: a primitive that refused everything would satisfy both
    // safety cases below and read as a working fix while making stale daemons unreplaceable.
    expect(await retire(generation)).toEqual({ retiring: true, reason: 'retiring' })
  }, 120_000)

  it('refuses to retire a daemon that owns a live session', async () => {
    const generation = await launchOwnedDaemon('live')
    const client = openClient(generation)
    await admitSession(client, 'live')

    expect(await retire(generation)).toEqual({ retiring: false, reason: 'live_sessions' })
    expect(await processIdentityIsAlive(generation.identity)).toBe(true)
  }, 120_000)

  it('stops admitting work once it has agreed to retire', async () => {
    const generation = await launchOwnedDaemon('fence')
    const client = openClient(generation)
    // Why warm the socket first: a spawn on a cold adapter spends its first milliseconds
    // connecting, so a stimulus sent afterwards may never reach the daemon at all -- and a
    // request that never lands is indistinguishable from one the daemon refused.
    expect(await client.listProcesses()).toHaveLength(0)

    expect(await retire(generation)).toEqual({ retiring: true, reason: 'retiring' })

    // THE claim. Proving emptiness is worth nothing if the daemon keeps admitting afterwards:
    // that is precisely the defect of asking for a session count and then acting on the answer.
    // Here the proof and the fence are the same event, so this create cannot be lost -- it is
    // refused outright rather than accepted and then destroyed.
    await expect(
      client.spawn({
        sessionId: `${WORKTREE_ID}@@orca-w1b-after-fence-${randomUUID().slice(0, 8)}`,
        isNewSession: true,
        cols: 80,
        rows: 24,
        cwd: runtime.rootDir,
        ...(process.platform === 'win32' ? { shellOverride: 'cmd.exe' } : {})
      })
    ).rejects.toThrow()
  }, 120_000)
})
