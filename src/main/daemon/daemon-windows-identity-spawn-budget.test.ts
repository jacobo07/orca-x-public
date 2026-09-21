import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type * as ChildProcessModule from 'node:child_process'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * How many powershell.exe CIM spawns one Windows startup pays to identify ONE daemon pid.
 *
 * Counted at the real spawn boundary (`execFile`), not at either CIM wrapper, so the number
 * survives a refactor that moves which module owns the query -- and so it sees both
 * implementations (daemon-process-identity-query and daemon-process-inspection) at once.
 *
 * Nothing is really spawned: a count is what is being measured, and a real spawn would make the
 * measurement resource-sensitive for no gain. Latency is a separate gate that needs host headroom.
 */
const stub = vi.hoisted(() => ({
  powershell: [] as string[][],
  commandLine: 'C:\\some\\other\\process.exe --unrelated'
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  const respond = (file: string, args: readonly string[]): string => {
    if (file !== 'powershell.exe') {
      return ''
    }
    stub.powershell.push([...args])
    // Shape satisfies both parsers: {cmd,start} and {status,cmd,start}.
    return JSON.stringify({ status: 'present', cmd: stub.commandLine, start: Date.now() })
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
  // Node's execFile carries a promisify.custom that resolves {stdout, stderr}; without it,
  // promisify would resolve a bare string and every caller's destructure would silently miss.
  Object.defineProperty(fakeExecFile, promisify.custom, {
    value: async (file: string, args: readonly string[]) => ({
      stdout: respond(file, args),
      stderr: ''
    })
  })
  return { ...actual, execFile: fakeExecFile }
})

const { getDaemonLaunchIdentity } = await import('./daemon-pid-identity')
const { isDaemonStaleForCurrentBundle } = await import('./daemon-bundle-staleness')
const { killStaleDaemon } = await import('./daemon-stale-kill')
const { PROTOCOL_VERSION } = await import('./types')

const runtimeDir = mkdtempSync(join(tmpdir(), 'orca-spawn-budget-'))
const socketPath = join(runtimeDir, 'daemon.sock')
const tokenPath = join(runtimeDir, 'daemon.token')
const entryPath = join(runtimeDir, 'daemon-entry.js')
const pidPath = join(runtimeDir, `daemon-v${PROTOCOL_VERSION}.pid`)

const matchingCommandLine = `node ${entryPath} ${socketPath} ${tokenPath}`

afterAll(() => rmSync(runtimeDir, { recursive: true, force: true }))

/**
 * process.pid is live, so the `kill(pid, 0)` liveness gate passes and the CIM query is actually
 * reached. Callers below that pass a NON-matching command line resolve to 'mismatch', so no
 * signal is ever sent -- this process is never a destruction target.
 */
function writePidRecord(overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    pidPath,
    JSON.stringify({
      pid: process.pid,
      startedAtMs: Date.now(),
      launchNonce: 'w0-measurement-nonce',
      appVersion: '1.0.0',
      entryPath,
      ...overrides
    })
  )
}

beforeEach(() => {
  stub.powershell.length = 0
  stub.commandLine = 'C:\\some\\other\\process.exe --unrelated'
  writePidRecord()
})

describe('windows daemon identity spawn budget', () => {
  it('pays at most one CIM spawn for the clustered read-only identity questions', async () => {
    if (process.platform !== 'win32') {
      return
    }

    await getDaemonLaunchIdentity(runtimeDir, socketPath, tokenPath, entryPath)
    const afterLaunchIdentity = stub.powershell.length

    await isDaemonStaleForCurrentBundle(runtimeDir, socketPath, tokenPath, '1.0.0')
    const afterBundleStaleness = stub.powershell.length

    await killStaleDaemon(runtimeDir, socketPath, tokenPath, undefined, {
      probeEndpoint: async () => 'missing'
    })
    const total = stub.powershell.length

    const breakdown =
      `launchIdentity=${afterLaunchIdentity} ` +
      `bundleStaleness=${afterBundleStaleness - afterLaunchIdentity} ` +
      `staleKill=${total - afterBundleStaleness} total=${total}`

    // Budget is 2, not 1, and the difference is the whole safety argument: the two read-only
    // questions are adjacent and ask the same thing of the same record, so one answer serves
    // both. The destructive probe happens seconds later, after health checks and grace retries,
    // and authorizes a signal -- it must be fresh. See the recycle control below.
    expect(total, `CIM spawns for one pid in one startup: ${breakdown}`).toBeLessThanOrEqual(2)
  })

  it('does not re-query a command line it has already read', async () => {
    if (process.platform !== 'win32') {
      return
    }
    // A record without entryPath is the legacy shape: the launch check falls back to the command
    // line, which the identity query in the same call already fetched and threw away.
    stub.commandLine = matchingCommandLine
    writePidRecord({ entryPath: undefined })

    const identity = await getDaemonLaunchIdentity(runtimeDir, socketPath, tokenPath, entryPath)

    expect(identity).toBe('match')
    expect(
      stub.powershell.length,
      'the same pid was queried twice for bytes the first query already returned'
    ).toBeLessThanOrEqual(1)
  })

  it('never serves the destructive probe from a memo, however recently one ran', async () => {
    if (process.platform !== 'win32') {
      return
    }
    // Safety control on any future spawn-reduction: a read-only probe immediately before the
    // destructive one must NOT satisfy it. Between the two the daemon can die and its pid be
    // recycled, and signalling on the earlier answer is exactly that defect.
    await getDaemonLaunchIdentity(runtimeDir, socketPath, tokenPath, entryPath)
    const beforeKill = stub.powershell.length
    expect(beforeKill).toBeGreaterThan(0)

    await killStaleDaemon(runtimeDir, socketPath, tokenPath, undefined, {
      probeEndpoint: async () => 'missing'
    })

    expect(
      stub.powershell.length - beforeKill,
      'the destructive path reused a stale identity answer'
    ).toBe(1)
  })

  it('re-probes when the pid record changes, so a memo cannot outlive its subject', async () => {
    if (process.platform !== 'win32') {
      return
    }
    await getDaemonLaunchIdentity(runtimeDir, socketPath, tokenPath, entryPath)
    const afterFirst = stub.powershell.length

    // A different incarnation of the same pid: any memo keyed on something weaker than the
    // record's own bytes would answer this from the previous daemon's evidence.
    writePidRecord({ startedAtMs: Date.now() + 60_000, launchNonce: 'a-different-incarnation' })
    await getDaemonLaunchIdentity(runtimeDir, socketPath, tokenPath, entryPath)

    expect(stub.powershell.length, 'a changed pid record was answered from a memo').toBeGreaterThan(
      afterFirst
    )
  })

  it('queries only the recorded pid, so the count is attributable to one subject', async () => {
    if (process.platform !== 'win32') {
      return
    }
    await getDaemonLaunchIdentity(runtimeDir, socketPath, tokenPath, entryPath)
    // Positive control: the counter is wired to a real query, not silently counting nothing.
    expect(stub.powershell.length).toBeGreaterThan(0)
    for (const args of stub.powershell) {
      expect(args.join(' ')).toContain(`ProcessId = ${process.pid}`)
    }
  })
})
