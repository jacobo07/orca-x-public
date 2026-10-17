import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'

import type { ElectronApplication, Page } from '@stablyai/playwright-test'

import { expect, test } from './helpers/orca-app'
import { startHwfCarrier } from './helpers/hwf-two-host-carrier'
import {
  connectHwfTargetWithTrust,
  disconnectHwfTarget,
  execOnOwningHost,
  readHwfLocalPort,
  readHwfRunFile
} from './helpers/hwf-two-host-ssh-target'
import { waitForSessionReady } from './helpers/store'
import { runCliRaw } from './helpers/hwf-two-host-replica-cli'
import {
  addLocalReplica,
  addRemoteRepo,
  asReplicaRun,
  waitForRootGrouping,
  waitForSshConnected,
  type HwfReplicaRun
} from './helpers/hwf-two-host-replica-legs'
import {
  RELAY_TOO_OLD_WORD,
  WORKTREE_UNVERIFIED_WORD,
  currentRelayVerdict,
  notRunVerdict,
  oldRelayVerdict,
  requirePass,
  type LegVerdict,
  type RelayLogCounts
} from './helpers/hwf-two-host-replica-verdict'
import type { HwfRun } from './helpers/hwf-two-host-ssh-target'

/**
 * REAL-TWO-HOST rung for phase 23 (matrix row 74): a laptop Orca against a GEX44 relay that does not
 * advertise sync.v1/fabric.v1 must never send a sync./fabric. method. Opt-in: a skip means NOT RUN.
 */

test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' || !process.env.ORCA_HWF_RUN_FILE,
  'needs ORCA_HWF_TWO_HOST=1 and ORCA_HWF_RUN_FILE for an /tmp/orca-hwf-p23-* root; a skip is NOT RUN'
)

const relayPath = process.env.ORCA_HWF_P23_RELAY_PATH ?? path.join(process.cwd(), 'out', 'relay')

// Why: no relay logs request methods (an old one never will), so the instrument is the app's own
// count at the multiplexer write, switched on only for this spec. The current-relay test is its
// positive control: the same tally must see sync.replicaFacts there.
const TALLY_ENV = { ORCA_E2E_RELAY_METHOD_TALLY: '1' }
const TALLY_KEY = '__orcaRelaySentMethods'

test.use({ seedTestRepo: false, orcaAppExtraEnv: { ORCA_RELAY_PATH: relayPath, ...TALLY_ENV } })

test.describe.configure({ mode: 'serial' })

async function readSentTally(app: ElectronApplication): Promise<Record<string, number> | null> {
  return (await app.evaluate(
    (_electron, key) => (globalThis as Record<string, unknown>)[key] ?? null,
    TALLY_KEY
  )) as Record<string, number> | null
}

// Methods this app wrote to its relays, in the shared verdict's shape: `logs` is 1 when the tally
// exists and `methods` the total sent, so a missing tally (switch off, nothing sent) fails the control.
async function readSentMethodCounts(app: ElectronApplication): Promise<RelayLogCounts> {
  const tally = await readSentTally(app)
  const entries = Object.entries(tally ?? {})
  const sum = (keep: (method: string) => boolean): number =>
    entries.filter(([m]) => keep(m)).reduce((n, [, c]) => n + c, 0)
  console.log(`HWF74_SENT_TALLY ${JSON.stringify(tally)}`)
  return {
    logs: tally === null ? 0 : 1,
    methods: sum(() => true),
    syncOrFabric: sum((m) => /^(sync|fabric)\./.test(m)),
    replicaFacts: sum((m) => m === 'sync.replicaFacts')
  }
}

function installOldRelay(run: HwfRun): void {
  const verb = spawnSync(
    process.execPath,
    [
      path.join(process.cwd(), 'config', 'scripts', 'hwf-two-host-remote.mjs'),
      'old-relay-p23',
      run.root
    ],
    { encoding: 'utf8' }
  )
  expect(verb.status).toBe(0)
  expect(verb.stdout).toContain('P23_OLD_RELAY version=0.0.0')
  console.log(verb.stdout.trim())
}

async function openTarget(orcaPage: Page, run: HwfRun) {
  // Why: the target is 127.0.0.1:<local port>; without the carrier forward nothing listens there.
  const carrier = await startHwfCarrier(run, readHwfLocalPort())
  const target = await connectHwfTargetWithTrust(orcaPage, run, readHwfLocalPort()).catch(
    async (err) => {
      await carrier.kill()
      throw err
    }
  )
  return { carrier, target }
}

test('old relay: sync/fabric methods are never sent', async ({ orcaPage, electronApp }) => {
  const run = readHwfRunFile()
  expect(run.root).toMatch(/^\/tmp\/orca-hwf-p23-[0-9A-Za-z]+$/)
  await waitForSessionReady(orcaPage)
  installOldRelay(run)
  const { carrier, target } = await openTarget(orcaPage, run)
  try {
    await waitForSshConnected(orcaPage, target.targetId, { timeoutMs: 60_000 })
    const counts = await readSentMethodCounts(electronApp)
    console.log(`P23_NO_SYNC_FABRIC_SENT count=${counts.syncOrFabric} methods=${counts.methods}`)
    // Positive control: a zero from a tally that saw no writes proves nothing.
    expect(counts.logs).toBe(1)
    expect(counts.methods).toBeGreaterThan(0)
    expect(counts.syncOrFabric).toBe(0)
  } finally {
    await disconnectHwfTarget(orcaPage, target.targetId)
    await carrier.kill()
  }
})

function logLeg(leg: string, v: LegVerdict): void {
  console.log(`${leg} ${v.verdict} ${v.cause}`)
}

// Why: an unseeded p23 root cannot hold an equal-tips pair, so the compare leg is NOT RUN rather than guessed.
function seededRunOrNull(run: HwfRun): HwfReplicaRun | null {
  try {
    return asReplicaRun(run)
  } catch {
    return null
  }
}

// Why: the p16 seeds diverge by design (one host commit each), and the remote worktree fact, the
// only sync.* request, is read only for equal tips. Fresh clones of both seeds, reset to the shared
// seed root, are the one pair on which the sync.v1 gate is reached at all.
function makeEqualTipsPair(run: HwfReplicaRun, leg: string): { local: string; remote: string } {
  expect(run.seedRoot).toMatch(/^[0-9a-f]{40}$/)
  const remote = `${path.posix.dirname(run.replicaPath)}/p23-equal-${leg}`
  const made = execOnOwningHost(
    run,
    `git clone -q '${run.replicaPath}' '${remote}' && git -C '${remote}' reset -q --hard ${run.seedRoot} && git -C '${remote}' rev-parse HEAD`
  )
  expect(made.status, made.out).toBe(0)
  expect(made.out.trim().split('\n').pop()).toBe(run.seedRoot)
  const local = path.join(path.dirname(run.localReplicaPath), `p23-equal-${leg}`)
  const git = (args: string[]): string =>
    execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' }).trim()
  git(['clone', '-q', '--no-hardlinks', run.localReplicaPath, local])
  git(['-C', local, 'reset', '-q', '--hard', run.seedRoot])
  expect(git(['-C', local, 'rev-parse', 'HEAD'])).toBe(run.seedRoot)
  console.log(`HWF74_EQUAL_TIPS leg=${leg} tip=${run.seedRoot}`)
  return { local, remote }
}

async function compareEqualTipsPair(
  orcaPage: Page,
  userData: string,
  run: HwfReplicaRun,
  connected: { targetId: string; label: string },
  leg: string
): Promise<{ output: string; status: number }> {
  await waitForSshConnected(orcaPage, connected.targetId, { timeoutMs: 60_000 })
  const pair = makeEqualTipsPair(run, leg)
  const localRepoId = await addLocalReplica(orcaPage, pair.local)
  const remoteRepoId = await addRemoteRepo(orcaPage, connected, pair.remote, 'HWF74 p23')
  const grouping = await waitForRootGrouping(orcaPage, run.seedRoot, [localRepoId, remoteRepoId])
  const r = runCliRaw(['project', 'replica-compare', '--project', grouping.projectId], userData)
  console.log(`HWF74_COMPARE exit=${r.status} out=${r.stdout.trim()}`)
  return { output: r.stdout, status: r.status }
}

function skipUnseeded(leg: string, cause: string): void {
  const v = notRunVerdict(cause)
  logLeg(leg, v)
  test.info().annotations.push({ type: 'NOT RUN', description: v.cause })
  test.skip(true, `${v.cause}; a skip is NOT RUN`)
}

test('old relay: replica-compare says so and sends no sync/fabric method', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(900_000)
  const run = readHwfRunFile()
  const seeded = seededRunOrNull(run)
  if (!process.env.ORCA_HWF_P23_RELAY_PATH || seeded === null) {
    skipUnseeded(
      'HWF74_OLD_RELAY',
      seeded === null
        ? 'the p23 run file has no replica seeds (run-file --seed --local-seed)'
        : 'needs ORCA_HWF_P23_RELAY_PATH naming a pre-sync relay build'
    )
    return
  }
  const expectedWord = process.env.ORCA_HWF_P23_EXPECTED_WORD ?? RELAY_TOO_OLD_WORD
  expect([RELAY_TOO_OLD_WORD, WORKTREE_UNVERIFIED_WORD]).toContain(expectedWord)
  await waitForSessionReady(orcaPage)
  installOldRelay(run)
  const { carrier, target } = await openTarget(orcaPage, run)
  try {
    const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const compare = await compareEqualTipsPair(orcaPage, userData, seeded, target, 'old')
    const verdict = oldRelayVerdict({
      compareOutput: compare.output,
      compareStatus: compare.status,
      relayLogCounts: await readSentMethodCounts(electronApp),
      expectedWord
    })
    logLeg('HWF74_OLD_RELAY', verdict)
    requirePass('old relay: replica-compare says so and sends no sync/fabric method', verdict)
    if (expectedWord === WORKTREE_UNVERIFIED_WORD) {
      // Why: a relay with git.replicaBundle but no sync.v1 must have compared for real, or the
      // sync.v1 gate was never reached and the zero above came from an earlier refusal.
      const exports = (await readSentTally(electronApp))?.['git.replicaBundleExport'] ?? 0
      console.log(`HWF74_GATE_REACHED replicaBundleExport=${exports}`)
      expect(exports).toBeGreaterThan(0)
    }
  } finally {
    await disconnectHwfTarget(orcaPage, target.targetId)
    await carrier.kill()
  }
})

test.describe('current relay', () => {
  test.use({
    orcaAppExtraEnv: { ORCA_RELAY_PATH: path.join(process.cwd(), 'out', 'relay'), ...TALLY_ENV }
  })

  test('current relay: sync.replicaFacts is sent', async ({ orcaPage, electronApp }) => {
    test.setTimeout(900_000)
    const run = readHwfRunFile()
    const seeded = seededRunOrNull(run)
    if (seeded === null) {
      skipUnseeded(
        'HWF74_CURRENT_RELAY',
        'the p23 run file has no replica seeds (run-file --seed --local-seed)'
      )
      return
    }
    await waitForSessionReady(orcaPage)
    const { carrier, target } = await openTarget(orcaPage, run)
    try {
      const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
      const before = await readSentMethodCounts(electronApp)
      await compareEqualTipsPair(orcaPage, userData, seeded, target, 'current')
      const after = await readSentMethodCounts(electronApp)
      // Why: only the requests this compare added count toward the control.
      const verdict = currentRelayVerdict({
        relayLogCounts: {
          ...after,
          replicaFacts: (after.replicaFacts ?? 0) - (before.replicaFacts ?? 0)
        }
      })
      logLeg('HWF74_CURRENT_RELAY', verdict)
      requirePass('current relay: sync.replicaFacts is sent', verdict)
    } finally {
      await disconnectHwfTarget(orcaPage, target.targetId)
      await carrier.kill()
    }
  })
})
