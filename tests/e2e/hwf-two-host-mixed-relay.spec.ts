import { spawnSync } from 'node:child_process'
import path from 'node:path'

import type { Page } from '@stablyai/playwright-test'

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
  parseRelayLogCounts,
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

test.use({ seedTestRepo: false, orcaAppExtraEnv: { ORCA_RELAY_PATH: relayPath } })

test.describe.configure({ mode: 'serial' })

test('old relay: sync/fabric methods are never sent', async ({ orcaPage }) => {
  const run = readHwfRunFile()
  expect(run.root).toMatch(/^\/tmp\/orca-hwf-p23-[0-9A-Za-z]+$/)
  await waitForSessionReady(orcaPage)

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

  // Why: the target is 127.0.0.1:<local port>; without the carrier forward nothing listens there.
  const carrier = await startHwfCarrier(run, readHwfLocalPort())
  const target = await connectHwfTargetWithTrust(orcaPage, run, readHwfLocalPort()).catch(async (err) => {
    await carrier.kill()
    throw err
  })
  try {
    // The owning host's own relay log is the independent instrument: zero gated requests arrived.
    const count = execOnOwningHost(
      run,
      "cat $(find . -name 'relay*.log' -type f 2>/dev/null) /dev/null | grep -Ec '\"method\":\"(sync|fabric)\\.' || true"
    )
    const n = Number(count.out.trim().split('\n').pop())
    // Positive control: a zero from no log, or a log that records no methods, proves nothing.
    const control = execOnOwningHost(
      run,
      "F=$(find . -name 'relay*.log' -type f 2>/dev/null); echo \"P23_RELAY_LOGS=$(echo $F | wc -w)\"; echo \"P23_RELAY_METHODS=$(cat $F /dev/null | grep -Ec '\"method\":' || true)\""
    )
    console.log(control.out.trim())
    console.log(`P23_NO_SYNC_FABRIC_SENT count=${n}`)
    expect(Number(/P23_RELAY_LOGS=(\d+)/.exec(control.out)?.[1] ?? 0)).toBeGreaterThan(0)
    expect(Number(/P23_RELAY_METHODS=(\d+)/.exec(control.out)?.[1] ?? 0)).toBeGreaterThan(0)
    expect(n).toBe(0)
  } finally {
    await disconnectHwfTarget(orcaPage, target.targetId)
    await carrier.kill()
  }
})

// Why: the same three greps as the test above, plus the sync.replicaFacts count the current relay must show.
function readRelayLogCounts(run: HwfRun): RelayLogCounts | null {
  const logs = "cat $(find . -name 'relay*.log' -type f 2>/dev/null) /dev/null"
  const control = execOnOwningHost(
    run,
    'F=$(find . -name \'relay*.log\' -type f 2>/dev/null); echo "P23_RELAY_LOGS=$(echo $F | wc -w)"; echo "P23_RELAY_METHODS=$(cat $F /dev/null | grep -Ec \'"method":\' || true)"'
  )
  const syncFabric = execOnOwningHost(
    run,
    `${logs} | grep -Ec '"method":"(sync|fabric)\\.' || true`
  )
  const replicaFacts = execOnOwningHost(
    run,
    `${logs} | grep -Ec '"method":"sync\\.replicaFacts"' || true`
  )
  return parseRelayLogCounts({
    controlOut: control.out,
    syncFabricOut: syncFabric.out,
    replicaFactsOut: replicaFacts.out
  })
}

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

async function compareEqualTipsPair(
  orcaPage: Page,
  userData: string,
  run: HwfReplicaRun,
  connected: { targetId: string; label: string }
): Promise<{ output: string; status: number }> {
  await waitForSshConnected(orcaPage, connected.targetId, { timeoutMs: 60_000 })
  const localRepoId = await addLocalReplica(orcaPage, run.localReplicaPath)
  const remoteRepoId = await addRemoteRepo(orcaPage, connected, run.replicaPath, 'HWF74 p23')
  const grouping = await waitForRootGrouping(orcaPage, run.seedRoot, [localRepoId, remoteRepoId])
  const r = runCliRaw(['project', 'replica-compare', '--project', grouping.projectId], userData)
  console.log(`HWF74_COMPARE exit=${r.status} out=${r.stdout.trim()}`)
  return { output: r.stdout, status: r.status }
}

test('old relay: replica-compare says so and sends no sync/fabric method', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(900_000)
  const reason = 'needs ORCA_HWF_P23_RELAY_PATH naming a pre-sync relay build; a skip is NOT RUN'
  const run = readHwfRunFile()
  const seeded = seededRunOrNull(run)
  if (!process.env.ORCA_HWF_P23_RELAY_PATH || seeded === null) {
    const v = notRunVerdict(
      seeded === null
        ? 'the p23 run file has no replica seeds (run-file --seed --local-seed)'
        : reason
    )
    logLeg('HWF74_OLD_RELAY', v)
    test.info().annotations.push({ type: 'NOT RUN', description: v.cause })
    test.skip(true, `${v.cause}; a skip is NOT RUN`)
    return
  }
  const expectedWord = process.env.ORCA_HWF_P23_EXPECTED_WORD ?? RELAY_TOO_OLD_WORD
  expect([RELAY_TOO_OLD_WORD, WORKTREE_UNVERIFIED_WORD]).toContain(expectedWord)
  await waitForSessionReady(orcaPage)
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

  const carrier = await startHwfCarrier(run, readHwfLocalPort())
  const target = await connectHwfTargetWithTrust(orcaPage, run, readHwfLocalPort()).catch(
    async (err) => {
      await carrier.kill()
      throw err
    }
  )
  try {
    const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const compare = await compareEqualTipsPair(orcaPage, userData, seeded, target)
    const verdict = oldRelayVerdict({
      compareOutput: compare.output,
      compareStatus: compare.status,
      relayLogCounts: readRelayLogCounts(run),
      expectedWord
    })
    logLeg('HWF74_OLD_RELAY', verdict)
    requirePass('old relay: replica-compare says so and sends no sync/fabric method', verdict)
  } finally {
    await disconnectHwfTarget(orcaPage, target.targetId)
    await carrier.kill()
  }
})

test.describe('current relay', () => {
  // Needs a p23 root whose relay log directory is the one the old-relay tests read, with the current relay installed.
  test.use({ orcaAppExtraEnv: { ORCA_RELAY_PATH: path.join(process.cwd(), 'out', 'relay') } })

  test('current relay: sync.replicaFacts is sent', async ({ orcaPage, electronApp }) => {
    test.setTimeout(900_000)
    const run = readHwfRunFile()
    const seeded = seededRunOrNull(run)
    if (seeded === null) {
      const v = notRunVerdict(
        'the p23 run file has no replica seeds (run-file --seed --local-seed)'
      )
      logLeg('HWF74_CURRENT_RELAY', v)
      test.info().annotations.push({ type: 'NOT RUN', description: v.cause })
      test.skip(true, `${v.cause}; a skip is NOT RUN`)
      return
    }
    await waitForSessionReady(orcaPage)
    const carrier = await startHwfCarrier(run, readHwfLocalPort())
    const target = await connectHwfTargetWithTrust(orcaPage, run, readHwfLocalPort()).catch(
      async (err) => {
        await carrier.kill()
        throw err
      }
    )
    try {
      const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
      const before = readRelayLogCounts(run)
      await compareEqualTipsPair(orcaPage, userData, seeded, target)
      const after = readRelayLogCounts(run)
      // Why: the log may hold earlier runs, so only the requests this compare added count.
      const counts =
        before === null ||
        after === null ||
        before.replicaFacts === null ||
        after.replicaFacts === null
          ? null
          : { ...after, replicaFacts: after.replicaFacts - before.replicaFacts }
      const verdict = currentRelayVerdict({ relayLogCounts: counts })
      logLeg('HWF74_CURRENT_RELAY', verdict)
      requirePass('current relay: sync.replicaFacts is sent', verdict)
    } finally {
      await disconnectHwfTarget(orcaPage, target.targetId)
      await carrier.kill()
    }
  })
})
