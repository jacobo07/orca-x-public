import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createLegacyDaemonAdapters } from '../../src/main/daemon/daemon-init'
import { killStaleDaemon } from '../../src/main/daemon/daemon-stale-kill'
import { getDaemonPidPath, serializeDaemonPidFile } from '../../src/main/daemon/daemon-spawner'
import {
  ATOMIC_RETIREMENT_DAEMON_PROTOCOL_VERSION,
  PROTOCOL_VERSION
} from '../../src/main/daemon/daemon-protocol-version'
import { DaemonPtyAdapter } from '../../src/main/daemon/daemon-pty-adapter'
import {
  createDaemonGenerationRuntime,
  launchDaemonGeneration,
  type DaemonGeneration,
  type DaemonGenerationRuntime
} from './helpers/daemon-generation-safety-fixtures'
import {
  processIdentityIsAlive,
  recordProcessIdentity,
  recordProcessTree,
  terminateRecordedTree,
  type RecordedProcessIdentity
} from './helpers/daemon-generation-processes'

/**
 * Version skew is the last way a proven safety authority can be bypassed.
 *
 * The atomic retirement request shipped into protocol 35 without moving the number, so two builds
 * advertised 35 — one that answers the request, one that rejects it as an unknown type. Because
 * the endpoint name carries the generation, the older build shared the current endpoint and was
 * discovered as a same-version stale daemon, which is the one population automatic replacement is
 * allowed to destroy. Its rejection is not evidence about live work, so the caller fell through
 * to the pre-signal count: a race, reachable, on real user sessions.
 *
 * Measured against the real pre-atomic build (85c15d6da, PROTOCOL_VERSION 35, the request absent
 * from all of src/): it connects and answers `Unknown request type: retireIfNoLiveWork`.
 *
 * What this file pins is the remedy, and the remedy is relocation rather than repair: at
 * generation 36 that whole population sits behind its own endpoint, where the client ADOPTS it
 * instead of replacing it. 35 is written out by hand throughout — deriving it from
 * PROTOCOL_VERSION would let the next bump carry this boundary forward and erase the evidence.
 */
const PRE_ATOMIC_GENERATION = 35
const FIXTURE_ENTRY_FILE = 'orca-w1-daemon-entry.cjs'
const WORKTREE_ID = 'orca-w1-skew'

let runtime: DaemonGenerationRuntime
const ownedIdentities: RecordedProcessIdentity[] = []
const openAdapters: DaemonPtyAdapter[] = []

function track(adapter: DaemonPtyAdapter): DaemonPtyAdapter {
  openAdapters.push(adapter)
  return adapter
}

/** The pid record production would have written, so the real identity check can return 'match'. */
function publishPidRecord(generation: DaemonGeneration): void {
  writeFileSync(
    getDaemonPidPath(runtime.daemonDir, generation.protocolVersion),
    serializeDaemonPidFile({
      pid: generation.identity.pid,
      startedAtMs: generation.identity.startedAtMs,
      entryPath: runtime.entryPath,
      appVersion: '0.0.0-w1-skew-fixture',
      launchNonce: randomUUID(),
      linuxStartTicks: null,
      bootId: null,
      spawnerExecPath: runtime.electronPath
    }),
    'utf8'
  )
}

async function launchOwnedDaemon(
  label: string,
  protocolVersion: number
): Promise<DaemonGeneration> {
  const generation = await launchDaemonGeneration({ runtime, label, protocolVersion })
  ownedIdentities.push(...(await recordProcessTree(generation.identity)))
  publishPidRecord(generation)
  return generation
}

async function admitSession(generation: DaemonGeneration, label: string): Promise<string> {
  const client = track(
    new DaemonPtyAdapter({
      socketPath: generation.socketPath,
      tokenPath: generation.tokenPath,
      protocolVersion: generation.protocolVersion
    })
  )
  const sessionId = `${WORKTREE_ID}@@orca-w1-${label}-${randomUUID().slice(0, 8)}`
  const result = await client.spawn({
    sessionId,
    isNewSession: true,
    cols: 80,
    rows: 24,
    cwd: runtime.rootDir,
    ...(process.platform === 'win32' ? { shellOverride: 'cmd.exe' } : {})
  })
  if (!result.pid) {
    throw new Error(`Session ${label} did not expose a root pid`)
  }
  // Why the root identity and not its tree: a tree capture enumerates the whole process table
  // through a PowerShell spawn, and this file already pays for that once per daemon. Doing it
  // per session made the harness heavy enough to starve the host it was measuring on.
  ownedIdentities.push(await recordProcessIdentity(result.pid))
  return sessionId
}

/** The real adoption authority, driven against the fixture's own runtime namespace. */
async function adoptLegacyDaemons(): Promise<DaemonPtyAdapter[]> {
  const adapters = await createLegacyDaemonAdapters(runtime.daemonDir, runtime.rootDir)
  for (const adapter of adapters) {
    track(adapter)
  }
  return adapters
}

beforeAll(async () => {
  runtime = await createDaemonGenerationRuntime(null, { entryFileName: FIXTURE_ENTRY_FILE })
}, 180_000)

afterEach(async () => {
  for (const adapter of openAdapters.splice(0)) {
    await adapter.disconnectOnly().catch(() => {})
    adapter.dispose()
  }
  await terminateRecordedTree(ownedIdentities.splice(0))
}, 120_000)

afterAll(() => {
  runtime?.remove()
})

describe('a daemon that predates atomic retirement is adopted, never replaced', () => {
  it('declares the capability boundary above every previously shipped generation', () => {
    // Not the decisive gate — §19 — but the cheapest statement of what the endpoint split means.
    expect(ATOMIC_RETIREMENT_DAEMON_PROTOCOL_VERSION).toBe(36)
    expect(PROTOCOL_VERSION).toBe(ATOMIC_RETIREMENT_DAEMON_PROTOCOL_VERSION)
    expect(PRE_ATOMIC_GENERATION).toBeLessThan(ATOMIC_RETIREMENT_DAEMON_PROTOCOL_VERSION)
  })

  it('adopts a pre-atomic daemon and keeps its live session reachable', async () => {
    const generation = await launchOwnedDaemon('pre-atomic', PRE_ATOMIC_GENERATION)
    const sessionId = await admitSession(generation, 'pre-atomic')

    const adapters = await adoptLegacyDaemons()

    // THE claim. Before the generation moved, 35 WAS the current generation: it was absent from
    // the adoptable population and present in the one automatic replacement destroys.
    expect(adapters).toHaveLength(1)

    // Adoption that loses the sessions is not preservation. Ask the adopted adapter itself —
    // a daemon that is merely alive tells us nothing about whether its work is still reachable.
    const adopted = await adapters[0].listProcesses()
    expect(adopted.map((process) => process.id)).toContain(sessionId)
    expect(await processIdentityIsAlive(generation.identity)).toBe(true)
  }, 180_000)

  it('leaves the current generation out of the adoptable population', async () => {
    const generation = await launchOwnedDaemon('current', PROTOCOL_VERSION)
    await admitSession(generation, 'current')

    // The liveness half, and the control that makes the assertion above discriminating: an
    // adoption rule that swallowed every generation would satisfy it while making a genuinely
    // stale current-generation daemon unreplaceable forever.
    expect(await adoptLegacyDaemons()).toHaveLength(0)
    expect(await processIdentityIsAlive(generation.identity)).toBe(true)
  }, 180_000)

  it('refuses safe replacement of a pre-atomic daemon instead of falling back to the count', async () => {
    const generation = await launchOwnedDaemon('fail-closed', PRE_ATOMIC_GENERATION)
    await admitSession(generation, 'fail-closed')

    const outcome = await killStaleDaemon(
      runtime.daemonDir,
      generation.socketPath,
      generation.tokenPath,
      generation.protocolVersion,
      { preserveLiveWork: true }
    )

    if (outcome.preservedBy === 'identity_unverifiable') {
      // The Windows process-identity query missed its 3s budget, so this run observed nothing
      // about the capability boundary: the daemon was preserved for a reason that has nothing
      // to do with the claim. Raising rather than returning follows the composed gate — a skip
      // that reports green is a test accepting two outcomes and proving neither, and this one
      // would then pass on a host too busy to run it.
      throw new Error(
        'INCONCLUSIVE: the real process-identity probe degraded to unknown, so this run says ' +
          'nothing about the capability boundary. Re-run with more free physical memory.'
      )
    }

    // The decider must be the generation, not what this daemon happens to answer. This fixture
    // is built from current source, so it DOES implement the request — if the guard were removed
    // the outcome would be 'atomic_retirement_refused' and the daemon would survive anyway. Only
    // naming the guard tells the two apart, which is exactly what the old gate could not do.
    expect(outcome).toEqual({
      killed: false,
      liveOwnerSurvived: true,
      preservedBy: 'atomic_retirement_unsupported_generation'
    })
    expect(await processIdentityIsAlive(generation.identity)).toBe(true)
  }, 180_000)
})
