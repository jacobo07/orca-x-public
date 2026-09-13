import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  killStaleDaemon,
  type StaleDaemonKillOutcome
} from '../../src/main/daemon/daemon-stale-kill'
import { getDaemonPidPath, serializeDaemonPidFile } from '../../src/main/daemon/daemon-spawner'
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

// Why: production only recognises its own daemon when the command line contains
// 'daemon-entry' (daemon-pid-identity.ts). Naming the fixture bundle to satisfy that
// predicate is what lets this test drive the REAL identity check rather than stub it.
const FIXTURE_ENTRY_FILE = 'orca-w1-daemon-entry.cjs'
const PROTOCOL_VERSION_UNDER_TEST = 1
const WORKTREE_ID = 'orca-w1-window'

let runtime: DaemonGenerationRuntime
const ownedIdentities: RecordedProcessIdentity[] = []
const openAdapters: DaemonPtyAdapter[] = []

/**
 * Publishes the pid record production would have written for this daemon, using the start
 * time read from the OS so the real identity check returns 'match' rather than being stubbed.
 */
function publishPidRecord(generation: DaemonGeneration): void {
  writeFileSync(
    getDaemonPidPath(runtime.daemonDir, generation.protocolVersion),
    serializeDaemonPidFile({
      pid: generation.identity.pid,
      startedAtMs: generation.identity.startedAtMs,
      entryPath: runtime.entryPath,
      appVersion: '0.0.0-w1-fixture',
      launchNonce: randomUUID(),
      linuxStartTicks: null,
      bootId: null,
      spawnerExecPath: runtime.electronPath
    }),
    'utf8'
  )
}

function openClient(generation: DaemonGeneration): DaemonPtyAdapter {
  const adapter = new DaemonPtyAdapter({
    socketPath: generation.socketPath,
    tokenPath: generation.tokenPath,
    protocolVersion: generation.protocolVersion
  })
  openAdapters.push(adapter)
  return adapter
}

/** The T2 observation: exactly what daemon-init reads before authorizing destruction. */
async function observeLiveSessionCount(client: DaemonPtyAdapter): Promise<number> {
  return (await client.listProcesses()).length
}

async function admitSession(
  client: DaemonPtyAdapter,
  label: string
): Promise<{ sessionId: string; pid: number; elapsedMs: number }> {
  const sessionId = `${WORKTREE_ID}@@orca-w1-${label}-${randomUUID().slice(0, 8)}`
  const startedAt = performance.now()
  const result = await client.spawn({
    sessionId,
    isNewSession: true,
    cols: 80,
    rows: 24,
    cwd: runtime.rootDir,
    // Why cmd.exe: the interval under test is one process-identity spawn wide (300-800ms).
    // A PowerShell PTY takes longer than that to boot, so using it would time the writer out
    // of the window and report "not enterable" for a reason about the shell, not the race.
    ...(process.platform === 'win32' ? { shellOverride: 'cmd.exe' } : {})
  })
  if (!result.pid) {
    throw new Error(`Admitted session ${label} did not expose a root pid`)
  }
  return { sessionId, pid: result.pid, elapsedMs: performance.now() - startedAt }
}

async function launchOwnedDaemon(label: string): Promise<DaemonGeneration> {
  const generation = await launchDaemonGeneration({
    runtime,
    label,
    protocolVersion: PROTOCOL_VERSION_UNDER_TEST
  })
  ownedIdentities.push(...(await recordProcessTree(generation.identity)))
  publishPidRecord(generation)
  return generation
}

type DestructionRun = {
  outcome: StaleDaemonKillOutcome
  warnings: string[]
  elapsedMs: number
}

/**
 * Drives the real destructive path while capturing the guard's own decision lines.
 *
 * Measured on this host: under load the Windows process-identity query exceeds its 3s budget,
 * the identity degrades to 'unknown', and the daemon is preserved by the deliberate
 * unknown-is-not-permission rule. That preservation is correct and it is also unrelated to the
 * claim under test, so a run that took it has observed nothing and must be reported as
 * INCONCLUSIVE rather than counted as a pass — otherwise a fix could be credited with a
 * refusal the load produced.
 */
function startDestruction(generation: DaemonGeneration): {
  promise: Promise<DestructionRun>
  hasSettled: () => boolean
} {
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '))
  }
  const startedAt = performance.now()
  let settled = false
  const promise = killStaleDaemon(
    runtime.daemonDir,
    generation.socketPath,
    generation.tokenPath,
    generation.protocolVersion,
    // Why: the contract under test is automatic replacement, which is the caller that promises
    // to preserve live work. That daemon-init's automatic branch actually asks for it is a
    // separate claim, pinned in daemon-init-live-session-preservation.test.ts.
    { preserveLiveWork: true }
  ).then(
    (outcome) => {
      settled = true
      console.warn = originalWarn
      return { outcome, warnings, elapsedMs: performance.now() - startedAt }
    },
    (error: unknown) => {
      settled = true
      console.warn = originalWarn
      throw error
    }
  )
  return { promise, hasSettled: () => settled }
}

function assertDestructionPathWasConclusive(run: DestructionRun): void {
  const degraded = run.warnings.filter((line) => line.includes('identity_probe_failed'))
  if (degraded.length > 0) {
    throw new Error(
      `INCONCLUSIVE: the real process-identity probe degraded to unknown during this ` +
        `${Math.round(run.elapsedMs)}ms run, so the daemon was preserved for a reason that ` +
        `has nothing to do with the claim under test: ${degraded.join(' | ')}`
    )
  }
}

beforeAll(async () => {
  runtime = await createDaemonGenerationRuntime(null, { entryFileName: FIXTURE_ENTRY_FILE })
}, 120_000)

afterEach(async () => {
  for (const adapter of openAdapters.splice(0)) {
    await adapter.disconnectOnly().catch(() => {})
    adapter.dispose()
  }
  // Why: only identities this fixture recorded at creation time are ever signalled, so pid
  // reuse cannot turn cleanup into a licence over a process the harness did not create.
  await terminateRecordedTree(ownedIdentities.splice(0))
}, 60_000)

afterAll(() => {
  runtime?.remove()
})

describe('daemon replacement: a destructive authorization must still hold at the effect', () => {
  it('replaces a daemon that is genuinely empty at the effect boundary', async () => {
    const generation = await launchOwnedDaemon('empty')
    // Why resident: disconnecting the last client retires an empty daemon by design
    // (daemon-pty-adapter: "lets a never-used adapter retire its empty daemon on quit"),
    // so an observer that disconnects destroys the precondition it was measuring. A
    // second Orca window is exactly the client this scenario assumes exists.
    const client = openClient(generation)
    expect(await observeLiveSessionCount(client)).toBe(0)

    const run = await startDestruction(generation).promise
    assertDestructionPathWasConclusive(run)

    // Why: the negative control. Without it, a guard that refuses everything would satisfy
    // every safety assertion in this file and read as a working fix.
    //
    // Why liveOwnerSurvived is not asserted: after a confirmed kill it carries the tail
    // endpoint probe, which is connect-only. On Windows a just-killed daemon's named pipe
    // still accepts a connect for a short window, so the value is legitimately
    // non-deterministic here (measured: 1 of 3 runs). It is not dead weight in production --
    // daemon-health.test.ts pins it true for a real handover, where a replacement daemon takes
    // the endpoint during the kill -- so the remnant case cannot be closed by ranking a
    // confirmed exit above the probe. Separating the two needs a protocol round trip; that is
    // recorded as open debt rather than guessed at here.
    expect({
      killed: run.outcome.killed,
      daemonStillAlive: await processIdentityIsAlive(generation.identity)
    }).toEqual({ killed: true, daemonStillAlive: false })
  }, 120_000)

  it('refuses to replace a daemon that already owns live work', async () => {
    const generation = await launchOwnedDaemon('live-before')
    const client = openClient(generation)
    await admitSession(client, 'before')
    expect(await observeLiveSessionCount(client)).toBeGreaterThan(0)

    const run = await startDestruction(generation).promise
    assertDestructionPathWasConclusive(run)

    expect(run.outcome.killed).toBe(false)
    expect(await processIdentityIsAlive(generation.identity)).toBe(true)
  }, 120_000)

  it('does not destroy a session admitted between the last observation and the signal', async () => {
    const generation = await launchOwnedDaemon('mid-interval')
    // Why one resident client: it stays connected for the whole operation, which both keeps
    // the empty daemon from retiring itself and models the second Orca window that is the
    // only actor able to admit work during the interval.
    const writer = openClient(generation)

    // T2 — the authorization. The daemon is genuinely empty at this instant.
    expect(await observeLiveSessionCount(writer)).toBe(0)

    // T2 -> T4. Nothing in this interval re-reads session state today; the writer is a
    // second real client using the production admission path, exactly as another Orca
    // window or a mobile client would.
    const destruction = startDestruction(generation)
    const admission = await admitSession(writer, 'mid').then(
      (session) => ({ ok: true as const, session, settledBeforeKill: !destruction.hasSettled() }),
      (error: unknown) => ({ ok: false as const, error, settledBeforeKill: !destruction.hasSettled() })
    )
    const run = await destruction.promise
    assertDestructionPathWasConclusive(run)

    // RED VALIDITY — a race test that never enters the race proves nothing. The daemon
    // answering a create is its own evidence that it was alive and admitting at that
    // instant, so a successful admission that resolved before the destruction returned is
    // positive proof the session landed strictly inside (T2, T4).
    if (!admission.ok) {
      throw new Error(
        `INCONCLUSIVE: the writer never entered the interval. Destruction took ` +
          `${Math.round(run.elapsedMs)}ms; admission failed with ${String(admission.error)}`
      )
    }
    expect(admission.session.elapsedMs).toBeLessThan(run.elapsedMs)
    expect(admission.settledBeforeKill).toBe(true)

    // The claim: work admitted after the authorization was taken must not be destroyed by it.
    expect(run.outcome.killed).toBe(false)
    expect(await processIdentityIsAlive(generation.identity)).toBe(true)
  }, 120_000)
})
