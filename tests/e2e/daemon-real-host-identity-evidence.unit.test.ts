import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { freemem } from 'node:os'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inspectDaemonProcessIdentity } from '../../src/main/daemon/daemon-pid-identity'
import { PROTOCOL_VERSION } from '../../src/main/daemon/daemon-protocol-version'
import {
  createDaemonGenerationRuntime,
  launchDaemonGeneration,
  type DaemonGeneration,
  type DaemonGenerationRuntime
} from './helpers/daemon-generation-safety-fixtures'
import {
  processIdentityIsAlive,
  terminateRecordedTree,
  type RecordedProcessIdentity
} from './helpers/daemon-generation-processes'

/**
 * Every one of the four identity verdicts is already pinned — against a stubbed
 * `node:child_process` that emulates what the real PowerShell script prints
 * (daemon-windows-process-absence.test.ts). That stub can only express states someone already
 * believed existed, so what is unproven is not the branching: it is that the real host, the real
 * `powershell.exe` CIM query and a real Orca daemon actually produce them.
 *
 * This file asks the real thing. No mocks: a real daemon, real processes, and the production
 * `inspectDaemonProcessIdentity` called directly.
 *
 * It deliberately does NOT re-assert the spawn count or memo freshness. Those belong to
 * daemon-windows-identity-spawn-budget.test.ts, which counts at the real spawn boundary and
 * asserts EXACTLY one further query; a second, looser copy here would not add coverage, it would
 * give that gate's mutation drill a weaker place to pass. What that file explicitly leaves open is
 * latency — "a separate gate that needs host headroom" — which is R5 below.
 */

const execFileAsync = promisify(execFile)
const FIXTURE_ENTRY_FILE = 'orca-w4-daemon-entry.cjs'

/**
 * Below this the Windows CIM query stops being an instrument and becomes part of the load: the
 * same fixture family measured 4/4 conclusive at 881 MB free and failed wholesale at 478 MB. It
 * is a property of THIS evidence task, not of the product — nothing in src/ reads it.
 */
const HEADROOM_FLOOR_MB = 850
const LATENCY_SAMPLES = 7
/** Enough conclusive samples to describe a distribution; below this the run judged the host. */
const MIN_CONCLUSIVE_SAMPLES = 4
const SAMPLE_SPACING_MS = 300

const freeMb = (): number => Math.round(freemem() / 1024 / 1024)

/**
 * Preconditions use this and NOT processIdentityIsAlive, which enumerates the whole process table
 * through PowerShell. Measured: a full-table enumeration immediately before a single-pid query
 * pushed that query past its 3s budget and the run reported INCONCLUSIVE — the harness had become
 * the load it was measuring. A signal costs no subprocess at all.
 *
 * It is the weaker check (it cannot see a recycled pid), so incarnation is still verified by
 * identity where that matters: at capture, and at teardown.
 */
function pidIsOccupied(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let runtime: DaemonGenerationRuntime
let daemon: DaemonGeneration
let intruderPid: number
const daemonTree: RecordedProcessIdentity[] = []
const ownedChildren: ChildProcess[] = []
const memoryReadings: number[] = []

function noteMemory(): number {
  const mb = freeMb()
  memoryReadings.push(mb)
  return mb
}

/** Which liveness answer the OS gives — the branch production consults before any query runs. */
function livenessOf(pid: number): 'occupied' | 'missing' | 'permission_denied' | 'unavailable' {
  try {
    process.kill(pid, 0)
    return 'occupied'
  } catch (error) {
    const code = (error as { code?: string }).code
    return code === 'ESRCH' ? 'missing' : code === 'EPERM' ? 'permission_denied' : 'unavailable'
  }
}

/**
 * 'unknown' on a daemon we can see is alive is the instrument blowing its 3s budget, not a
 * verdict about the subject — and it is the documented failure mode of a starved host. A run that
 * took that branch has observed nothing, so it must say so rather than be counted either way.
 */
function assertConclusive(verdict: string, context: string): void {
  if (verdict === 'unknown') {
    throw new Error(
      `INCONCLUSIVE: the real identity probe degraded to 'unknown' while ${context}. The daemon ` +
        `was verified alive, so this is the host-inspection budget, not the product. ` +
        `Free memory now ${freeMb()} MB; readings this run: ${memoryReadings.join(', ')} MB.`
    )
  }
}

/**
 * A live process this file owns that is provably NOT the daemon.
 *
 * Ownership is the ChildProcess handle, so no process-table enumeration is needed to create it or
 * to clean it up — stronger evidence than a recorded pid, and free. The first version recorded an
 * identity here inside a retry loop whose catch could not tell "not visible yet" from "the query
 * mechanism failed", so on a loaded host it re-ran a whole-table enumeration until setup itself
 * collapsed and every claim in the file was skipped.
 *
 * Why ping and not `timeout`: `timeout` reads stdin and exits immediately under stdio 'ignore',
 * so the "live" subject would be a corpse and the mismatch case would silently measure absence.
 */
async function spawnOwnedNonDaemon(): Promise<number> {
  const child = spawn('cmd.exe', ['/c', 'ping', '-n', '60', '127.0.0.1'], { stdio: 'ignore' })
  ownedChildren.push(child)
  if (!child.pid) {
    throw new Error('HARNESS-FAILED: the non-daemon fixture process exposed no pid')
  }
  for (let attempt = 0; attempt < 100 && !pidIsOccupied(child.pid); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (!pidIsOccupied(child.pid)) {
    throw new Error('HARNESS-FAILED: the non-daemon fixture process never became observable')
  }
  return child.pid
}

/**
 * A real process whose command line Windows will not disclose. This is an unmockable 'unknown':
 * the query runs, the OS answers "present", and there are no bytes to bind the pid to anything.
 */
async function findUndisclosedProcess(): Promise<{ pid: number; name: string }> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      // ProcessId -gt 4 excludes pid 0: production tests liveness with process.kill(pid, 0)
      // before validating, and on a pid of 0 that addresses the process GROUP.
      'Get-CimInstance Win32_Process | Where-Object { $null -eq $_.CommandLine -and ' +
        '$_.ProcessId -gt 4 } | Select-Object -First 1 ProcessId,Name | ConvertTo-Json -Compress'
    ],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true }
  )
  const parsed = JSON.parse(stdout.trim() || 'null') as { ProcessId?: number; Name?: string } | null
  if (!parsed?.ProcessId) {
    throw new Error('HARNESS-FAILED: this host exposed no process with an undisclosed command line')
  }
  return { pid: parsed.ProcessId, name: String(parsed.Name ?? 'unknown') }
}

beforeAll(async () => {
  if (process.platform !== 'win32') {
    return
  }
  const before = noteMemory()
  if (before < HEADROOM_FLOOR_MB) {
    throw new Error(
      `RESOURCE-CONFOUNDED: ${before} MB free is below the ${HEADROOM_FLOOR_MB} MB floor ` +
        `calibrated for this fixture family. The CIM query would be measuring the load.`
    )
  }
  runtime = await createDaemonGenerationRuntime(null, { entryFileName: FIXTURE_ENTRY_FILE })
  daemon = await launchDaemonGeneration({
    runtime,
    label: 'w4-identity',
    protocolVersion: PROTOCOL_VERSION
  })
  intruderPid = await spawnOwnedNonDaemon()
  // Why the daemon's own identity rather than recordProcessTree: capturing a tree costs a
  // whole-table enumeration, and this file never admits a session, so the fixture daemon has no
  // descendants to capture — it runs as plain Node under ELECTRON_RUN_AS_NODE, with no renderer
  // or GPU children. Ownership is still (pid, startedAtMs), so teardown cannot signal a recycled
  // pid, and the fork handle is held besides.
  daemonTree.push(daemon.identity)
}, 180_000)

afterAll(async () => {
  for (const child of ownedChildren.splice(0)) {
    child.kill()
  }
  // Only identities recorded by (pid, startedAtMs) at capture are ever signalled, so pid reuse
  // cannot turn cleanup into a licence over a process this fixture did not create.
  if (daemonTree.length > 0) {
    await terminateRecordedTree(daemonTree.splice(0))
  }
  runtime?.remove()
}, 120_000)

describe('the four identity verdicts, against a real daemon on a real Windows host', () => {
  it('R1 — recognises a real running daemon as its own, by the canonical binding', async () => {
    if (process.platform !== 'win32') {
      return
    }
    expect(pidIsOccupied(daemon.identity.pid), 'daemon alive before the claim').toBe(true)

    const verdict = await inspectDaemonProcessIdentity(
      daemon.identity.pid,
      daemon.socketPath,
      daemon.tokenPath,
      daemon.identity.startedAtMs
    )
    assertConclusive(verdict, 'identifying the live daemon')
    expect(verdict).toBe('match')

    // NON-VACUITY. Without this, R1 says only "a live process returns match" — which a binding
    // that checked nothing would also satisfy. Same live pid, same real query, one wrong
    // argument: the verdict must turn over, so the match above is attributable to the binding.
    const wrongEndpoint = await inspectDaemonProcessIdentity(
      daemon.identity.pid,
      `${daemon.socketPath}.not-this-endpoint`,
      daemon.tokenPath,
      daemon.identity.startedAtMs
    )
    assertConclusive(wrongEndpoint, 'checking the daemon against a foreign endpoint')
    expect(wrongEndpoint).toBe('mismatch')
  }, 120_000)

  it('R2 — calls a live process that is not the daemon a mismatch, never absent or unknown', async () => {
    if (process.platform !== 'win32') {
      return
    }
    expect(pidIsOccupied(intruderPid), 'intruder alive before the claim').toBe(true)

    const verdict = await inspectDaemonProcessIdentity(
      intruderPid,
      daemon.socketPath,
      daemon.tokenPath,
      // Why a start time that cannot match: this case is about the command-line binding, and
      // passing one is required. The binding decides first — no value here can make a `ping`
      // command line look like the daemon's.
      Date.now()
    )
    assertConclusive(verdict, 'identifying a live non-daemon process')
    // The pid is occupied and the occupant is provably someone else. Reading that as absence
    // would authorize reclaiming an endpoint a stranger holds.
    expect(verdict).toBe('mismatch')
  }, 120_000)

  it('R3 — keeps a process it may not interrogate unknown, never absent and never a match', async () => {
    if (process.platform !== 'win32') {
      return
    }
    const undisclosed = await findUndisclosedProcess()

    // WHICH BRANCH, asserted rather than assumed. The first version of this case claimed to prove
    // the CIM "present but no command line" path, and did not: on this host every process whose
    // command line Windows withholds ALSO denies OpenProcess, so the verdict is settled by the
    // liveness probe before any query runs. A mutation collapsing that CIM branch left this case
    // green, which is how the mis-attribution surfaced. Pinning the precondition keeps the claim
    // honest and stops it drifting onto another branch unnoticed.
    expect(
      livenessOf(undisclosed.pid),
      `pid ${undisclosed.pid} (${undisclosed.name}) was expected to be unreadable to this process`
    ).toBe('permission_denied')

    const verdict = await inspectDaemonProcessIdentity(
      undisclosed.pid,
      daemon.socketPath,
      daemon.tokenPath,
      daemon.identity.startedAtMs
    )

    // The load-bearing claim: absence of evidence is not evidence of absence. A live process this
    // app may not inspect must never be reported as gone, or a stranger's pid becomes a
    // reclaimable endpoint. EPERM is a real, unfakeable refusal from the OS.
    //
    // The sibling branch — a process that IS readable while WMI returns no command line — has no
    // subject on a non-elevated host, so it is driven by the stub in
    // daemon-windows-process-absence.test.ts, which gained that case after this drill found
    // nothing in the estate covered it.
    expect(verdict).toBe('unknown')
  }, 120_000)

  it('R5 — the fresh query at the destructive boundary stays inside its budget', async () => {
    if (process.platform !== 'win32') {
      return
    }
    expect(pidIsOccupied(daemon.identity.pid), 'daemon alive before latency').toBe(true)

    const conclusive: number[] = []
    let degraded = 0
    const freeBefore = noteMemory()
    for (let i = 0; i < LATENCY_SAMPLES; i++) {
      // Why a gap: production issues this query once per decision. Seven back-to-back PowerShell
      // spawns is a burst it never makes, and measuring a burst measures the harness — an earlier
      // version of this loop degraded on sample 5 for exactly that reason.
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, SAMPLE_SPACING_MS))
      }
      const startedAt = performance.now()
      const verdict = await inspectDaemonProcessIdentity(
        daemon.identity.pid,
        daemon.socketPath,
        daemon.tokenPath,
        daemon.identity.startedAtMs
      )
      const elapsed = performance.now() - startedAt
      if (verdict === 'unknown') {
        // NOT a wrong answer, and not a product failure: the query exceeded its cap and the
        // product took its designed safe branch. It is a sample OF THE HOST, so it cannot be
        // averaged into a latency figure — but it is counted and reported, never quietly trimmed.
        degraded++
        continue
      }
      expect(verdict).toBe('match')
      conclusive.push(elapsed)
    }
    const freeAfter = noteMemory()

    const ordered = [...conclusive].sort((a, b) => a - b)
    const median = ordered.length > 0 ? Math.round(ordered[Math.floor(ordered.length / 2)]) : -1
    const max = ordered.length > 0 ? Math.round(ordered.at(-1)!) : -1
    const provenance =
      `conclusive=${conclusive.length}/${LATENCY_SAMPLES} degraded=${degraded} ` +
      `median=${median}ms max=${max}ms freeMB ${freeBefore}->${freeAfter}`

    // A run that judged almost nothing must not report a flattering median from the two samples
    // that happened to land. Below the floor, this observed the host and not the query.
    if (conclusive.length < MIN_CONCLUSIVE_SAMPLES) {
      throw new Error(
        `INCONCLUSIVE: only ${conclusive.length} of ${LATENCY_SAMPLES} samples completed inside ` +
          `the production budget, below the ${MIN_CONCLUSIVE_SAMPLES} needed to characterise it. ` +
          `This is the host, not the product — the degraded samples took the safe branch. ` +
          `${provenance}; readings this run: ${memoryReadings.join(', ')} MB.`
      )
    }

    // THE CLAIM. The safety argument for paying a SECOND query at the destructive boundary is
    // that it is affordable, so the typical fresh read must sit comfortably inside the budget
    // that authorizes it. Asserting the median rather than the max is deliberate: the max is a
    // property of whatever else the machine was doing, and pinning it would make this gate fail
    // on load while telling nobody anything about the query.
    expect(
      median,
      `the typical fresh identity query is not affordable at the destructive boundary: ${provenance}`
    ).toBeLessThan(3_000)
    console.info(`[W4] real host identity query latency: ${provenance}`)
  }, 180_000)

  // LAST: this one destroys the subject the cases above depend on.
  it('R4 — reports the daemon absent once it is really gone, not unknown', async () => {
    if (process.platform !== 'win32') {
      return
    }
    const gone = { pid: daemon.identity.pid, startedAtMs: daemon.identity.startedAtMs }
    // Reuses the tree captured in setup rather than enumerating again: same ownership evidence,
    // one fewer full-table query. Splicing also stops afterAll re-signalling a dead incarnation.
    await terminateRecordedTree(daemonTree.splice(0))
    expect(await processIdentityIsAlive(gone), 'daemon really gone before the claim').toBe(false)

    const verdict = await inspectDaemonProcessIdentity(
      gone.pid,
      daemon.socketPath,
      daemon.tokenPath,
      gone.startedAtMs
    )

    // 'unknown' here would preserve a daemon the OS has positively reported gone, and daemon-init
    // then adopts it in degraded mode — fresh terminals lose the daemon provider for a corpse.
    expect(verdict).toBe('absent')
  }, 180_000)
})
