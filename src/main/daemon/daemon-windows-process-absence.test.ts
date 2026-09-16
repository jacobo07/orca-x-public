import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Windows tells us three different things and the destructive path currently hears two.
 *
 * A terminated process keeps its pid reserved while any handle to it survives, so
 * `process.kill(pid, 0)` still succeeds while Win32_Process has no such row. That case reaches
 * the CIM query. One of the two queries in this codebase can say so; the other cannot.
 *
 * The stub below does not invent an answer -- it emulates what each real script prints when the
 * process does not exist, and the scripts genuinely differ: the weaker one guards its output on
 * `if ($p)` and so prints NOTHING, while the stronger one prints an explicit missing status.
 * Emulating them identically would measure the stub instead of the code.
 */
const stub = vi.hoisted(() => ({
  powershell: [] as string[][],
  /** What the OS is being asked to report about the recorded pid. */
  world: 'absent' as 'absent' | 'expected' | 'different-process' | 'query-broken',
  matchingCommandLine: '',
  startedAtMs: 0
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const respond = (file: string, args: readonly string[]): string => {
    if (file !== 'powershell.exe') {
      return ''
    }
    stub.powershell.push([...args])
    const script = args.join(' ')
    // Only the stronger script can report absence; it is the one that says so in its own text.
    const canReportMissing = script.includes("status = 'missing'")
    if (stub.world === 'query-broken') {
      return canReportMissing ? JSON.stringify({ status: 'query_failed' }) : ''
    }
    if (stub.world === 'absent') {
      return canReportMissing ? JSON.stringify({ status: 'missing' }) : ''
    }
    const cmd =
      stub.world === 'expected'
        ? stub.matchingCommandLine
        : 'C:\\Windows\\System32\\notepad.exe'
    return canReportMissing
      ? JSON.stringify({ status: 'present', cmd, start: stub.startedAtMs })
      : JSON.stringify({ cmd, start: stub.startedAtMs })
  }
  const fakeExecFile = (
    file: string,
    args: readonly string[],
    options: unknown,
    callback?: (error: Error | null, stdout: string, stderr: string) => void
  ): unknown => {
    const stdout = respond(file, args)
    const done = typeof options === 'function' ? (options as typeof callback) : callback
    queueMicrotask(() => done?.(null, stdout, ''))
    return { kill: (): void => {} }
  }
  Object.defineProperty(fakeExecFile, promisify.custom, {
    value: async (file: string, args: readonly string[]) => ({
      stdout: respond(file, args),
      stderr: ''
    })
  })
  return { ...actual, execFile: fakeExecFile }
})

const { inspectDaemonProcessIdentity, readVerifiedDaemonPid } = await import('./daemon-pid-identity')
const { killStaleDaemon } = await import('./daemon-stale-kill')
const { PROTOCOL_VERSION } = await import('./types')

const runtimeDir = mkdtempSync(join(tmpdir(), 'orca-absence-'))
const socketPath = join(runtimeDir, 'daemon.sock')
const tokenPath = join(runtimeDir, 'daemon.token')
const entryPath = join(runtimeDir, 'daemon-entry.js')
const pidPath = join(runtimeDir, `daemon-v${PROTOCOL_VERSION}.pid`)

stub.matchingCommandLine = `node ${entryPath} ${socketPath} ${tokenPath}`

afterAll(() => rmSync(runtimeDir, { recursive: true, force: true }))

let recordedStartedAtMs = 0

beforeEach(() => {
  stub.powershell.length = 0
  stub.world = 'absent'
  recordedStartedAtMs = Date.now()
  stub.startedAtMs = recordedStartedAtMs
  writeFileSync(
    pidPath,
    JSON.stringify({
      pid: process.pid,
      startedAtMs: recordedStartedAtMs,
      launchNonce: 'w2-absence-nonce',
      appVersion: '1.0.0',
      entryPath
    })
  )
})

/**
 * `unknown` is the only endpoint state that is neither proof of death nor proof of service, so
 * it isolates the identity verdict: whatever killStaleDaemon decides here, it decided from the
 * process inspection alone.
 */
const inconclusiveEndpoint = async (): Promise<'unknown'> => 'unknown'

describe('windows process absence is not an unknown observation', () => {
  it('reports a pid the OS says does not exist as absent, not unknown', async () => {
    if (process.platform !== 'win32') {
      return
    }
    stub.world = 'absent'

    const verdict = await inspectDaemonProcessIdentity(
      process.pid,
      socketPath,
      tokenPath,
      recordedStartedAtMs
    )

    // The OS positively answered. Calling that "we could not tell" discards the answer.
    expect(verdict).toBe('absent')
  })

  it('keeps a failed query unknown, never absent', async () => {
    if (process.platform !== 'win32') {
      return
    }
    // The control that matters most on a starved host: WMI down, timed out, access denied.
    stub.world = 'query-broken'

    expect(
      await inspectDaemonProcessIdentity(process.pid, socketPath, tokenPath, recordedStartedAtMs)
    ).toBe('unknown')
  })

  it('keeps a different process a mismatch, never absent or unknown', async () => {
    if (process.platform !== 'win32') {
      return
    }
    stub.world = 'different-process'

    expect(
      await inspectDaemonProcessIdentity(process.pid, socketPath, tokenPath, recordedStartedAtMs)
    ).toBe('mismatch')
  })

  it('keeps the expected daemon a match', async () => {
    if (process.platform !== 'win32') {
      return
    }
    stub.world = 'expected'

    expect(
      await inspectDaemonProcessIdentity(process.pid, socketPath, tokenPath, recordedStartedAtMs)
    ).toBe('match')
  })
})

describe('what absence means to the destructive path', () => {
  it('does not preserve a daemon the OS positively says is gone', async () => {
    if (process.platform !== 'win32') {
      return
    }
    stub.world = 'absent'

    const outcome = await killStaleDaemon(runtimeDir, socketPath, tokenPath, undefined, {
      probeEndpoint: inconclusiveEndpoint
    })

    // Preserving here costs the user daemon persistence: daemon-init adopts an unconfirmed
    // daemon in degraded mode, so fresh terminals lose the daemon provider -- for a process
    // the operating system already reported gone.
    expect(outcome.preservedBy).toBeUndefined()
    expect(outcome.liveOwnerSurvived).toBe(false)
  })

  it('still preserves a daemon whose identity query failed', async () => {
    if (process.platform !== 'win32') {
      return
    }
    stub.world = 'query-broken'

    const outcome = await killStaleDaemon(runtimeDir, socketPath, tokenPath, undefined, {
      probeEndpoint: inconclusiveEndpoint
    })

    // Absence of proof is not proof of death; this is the branch a low-memory host takes.
    expect(outcome.preservedBy).toBe('identity_unverifiable')
    expect(outcome.liveOwnerSurvived).toBe(true)
  })

  it('takes a fresh look at the process rather than reusing a read-only answer', async () => {
    if (process.platform !== 'win32') {
      return
    }
    stub.world = 'query-broken'
    await inspectDaemonProcessIdentity(process.pid, socketPath, tokenPath, recordedStartedAtMs)
    const beforeKill = stub.powershell.length
    expect(beforeKill).toBeGreaterThan(0)

    await killStaleDaemon(runtimeDir, socketPath, tokenPath, undefined, {
      probeEndpoint: inconclusiveEndpoint
    })

    expect(
      stub.powershell.length - beforeKill,
      'the destructive path reused an earlier identity answer'
    ).toBeGreaterThan(0)
  })

  /**
   * The case above primes with inspectDaemonProcessIdentity, which memoizes NOTHING -- the memo
   * lives in observeRecordedDaemonPid and is keyed on the pid record's own bytes. So that case
   * proves the destructive path asks *something*, and cannot tell a fresh ask from a memo hit:
   * routed through the memoized reader it still spawns, because it would be the first read of
   * that key. Measured: with the destructive path mutated to read through readVerifiedDaemonPid,
   * that case stays GREEN and this one goes red.
   *
   * The distinction is the whole safety property. Between a read-only observation and the signal,
   * the daemon can die and its pid be recycled, so evidence that was true when the memo cached it
   * is not evidence that the pid is still ours at the effect boundary. Priming the memo with the
   * SAME key the destructive path would hit is the only way to make the reuse observable.
   */
  it('does not authorize a signal from evidence the memo is already holding', async () => {
    if (process.platform !== 'win32') {
      return
    }
    // Why 'different-process' and not the broken-query world the sibling case uses: the memo
    // deliberately FORGETS 'unknown', because a loaded machine blowing the inspection budget must
    // not be remembered as a fact about the daemon. So a broken query primes nothing and this case
    // would prove nothing. 'expected' is the other wrong choice -- it would make killStaleDaemon
    // SIGTERM the pid in the record, which is this test process. A mismatch is remembered AND
    // signals nothing, so it is the only world in which reuse is observable and safe.
    stub.world = 'different-process'
    // Prime the memo on the exact key killStaleDaemon would reach: same runtime dir, socket,
    // token, protocol version and -- critically -- the same pid-record bytes. beforeEach rewrites
    // the record with a fresh startedAtMs, so no earlier test's entry can answer for this one.
    await readVerifiedDaemonPid(runtimeDir, socketPath, tokenPath)
    const primed = stub.powershell.length
    expect(primed, 'the memo was never populated, so this case proves nothing').toBeGreaterThan(0)

    // Same key again inside the TTL: this must be answered from the memo, or the priming above
    // is not doing what the test claims and the assertion below would pass for the wrong reason.
    await readVerifiedDaemonPid(runtimeDir, socketPath, tokenPath)
    expect(
      stub.powershell.length,
      'the memo did not answer a repeat read, so it cannot demonstrate reuse'
    ).toBe(primed)

    await killStaleDaemon(runtimeDir, socketPath, tokenPath, undefined, {
      probeEndpoint: inconclusiveEndpoint
    })

    expect(
      stub.powershell.length - primed,
      'the destructive path was answered from memoized identity evidence'
    ).toBeGreaterThan(0)
  })
})
