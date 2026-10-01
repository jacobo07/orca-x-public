import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from './helpers/orca-app'
import { logAbsenceScan, scanLaptopForContentNonces } from './helpers/hwf-two-host-absence-scan'
import { startHwfCarrier } from './helpers/hwf-two-host-carrier'
import {
  approvalHashFor,
  approveAndRun,
  asPrepareRun,
  captureJson,
  contractHeaderText,
  editPrepare,
  independentGitVersion,
  invokeRunStep,
  liveHostIdentity,
  measureNow,
  measureThroughApi,
  openPrepareSection,
  rowReasons,
  rowStates,
  shimPresent,
  storeDump,
  terminalTabPresent
} from './helpers/hwf-two-host-prepare-legs'
import { addRemoteRepo, runCliJson, waitForSshConnected } from './helpers/hwf-two-host-replica-legs'
import { pollHandle } from './helpers/hwf-two-host-replica-ui'
import {
  connectHwfTargetWithTrust,
  disconnectHwfTarget,
  execOnOwningHost,
  readHwfLocalPort,
  readHwfRunFile,
  type HwfRun
} from './helpers/hwf-two-host-ssh-target'
import { waitForSessionReady } from './helpers/store'

/**
 * REAL-TWO-HOST rung for phase 20: a laptop Orca measures a GEX44 project's orca.yaml contract and
 * runs only the approved, unchanged, same-host prepare step. Opt-in: a skip means NOT RUN.
 */

test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' || !process.env.ORCA_HWF_RUN_FILE,
  'needs ORCA_HWF_TWO_HOST=1 and ORCA_HWF_RUN_FILE (hwf-two-host-remote.mjs run-file --seed20 --sentinel-nonce); a skip is NOT RUN'
)

const relayPath = process.env.ORCA_HWF_P20_RELAY_PATH ?? path.join(process.cwd(), 'out', 'relay')

// Why: the e2e fixture only injects ORCA_RELAY_PATH for the docker/localhost flags, which this rung must not set.
test.use({ seedTestRepo: false, orcaAppExtraEnv: { ORCA_RELAY_PATH: relayPath } })

test.describe.configure({ mode: 'serial' })

const SEEDED: Record<string, string> = {
  'git-ok': 'satisfied',
  'git-too-new': 'incompatible',
  'absent-tool': 'missing',
  'mac-only': 'unsupported',
  shim: 'needs-authorization',
  gpu: 'unknown',
  token: 'satisfied'
}

function joinMap(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}:${v}`)
    .join(',')
}

/** Relay fence: the deployed directory on the host must carry the version the laptop shipped. */
async function relayFence(run: HwfRun): Promise<{ local: string; remote: string[] }> {
  const local = readFileSync(path.join(relayPath, 'linux-x64', '.version'), 'utf8').trim()
  const remote = await pollHandle(
    async () =>
      execOnOwningHost(run, 'ls home/.orca-remote 2>/dev/null')
        .out.split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    (dirs) => dirs.includes(`relay-${local}`),
    60_000
  )
  return { local, remote }
}

test.describe('two-host prepare this device', () => {
  test('prepares GEX44 from its declared contract', async ({ orcaPage, electronApp }) => {
    test.skip(process.env.ORCA_HWF_P20_OLD_RELAY === '1', 'old-relay run executes test B only')
    test.setTimeout(1_500_000)
    const startedAtMs = Date.now()
    const run = asPrepareRun(readHwfRunFile())
    const localPort = readHwfLocalPort()
    await waitForSessionReady(orcaPage)
    const repoCount = await orcaPage.evaluate(() => window.__store?.getState().repos.length ?? -1)
    expect(repoCount).toBe(0)
    console.log('HWF20_ZERO_REPOS=yes')

    const captureDir = mkdtempSync(path.join(os.tmpdir(), 'orca-hwf-p20-capture-'))
    const carrier = await startHwfCarrier(run, localPort)
    let carrierDown = false
    let targetId: string | null = null
    try {
      const connected = await connectHwfTargetWithTrust(orcaPage, run, localPort)
      targetId = connected.targetId
      expect(connected.pin).toBe(run.fingerprint)
      const fence = await relayFence(run)
      const fenceMatch = fence.remote.length === 1 && fence.remote[0] === `relay-${fence.local}`
      console.log(
        `HWF20_RELAY_FENCE=${fenceMatch ? 'match' : 'mismatch'} local=${fence.local} remote=${fence.remote.join(',')}`
      )
      expect(fenceMatch).toBe(true)
      await waitForSshConnected(orcaPage, targetId, { timeoutMs: 60_000 })
      const repoId = await addRemoteRepo(orcaPage, connected, run.projectPath, 'HWF20 project')
      const { identity, live } = await liveHostIdentity(orcaPage, targetId)
      console.log(`HWF20_IDENTITY=${identity} live=${live}`)
      expect(identity).toBe('pinned')

      // L1: the person measures; every seeded state shows on the rows.
      await openPrepareSection(orcaPage, repoId)
      expect(await measureNow(orcaPage)).toBe('rows')
      const l1States = await rowStates(orcaPage)
      const api1 = await measureThroughApi(orcaPage, repoId)
      captureJson(captureDir, 'measure-l1', api1)
      const hostKey = api1.measurement.hostKey
      const measuredOs =
        api1.measurement.status === 'measured' ? api1.measurement.platform.os : 'none'
      const gitVersion =
        (api1.measurement.status === 'measured'
          ? api1.measurement.probes.find((p) => p.id === 'git-ok')?.version
          : undefined) ?? 'none'
      const independent = independentGitVersion(run)
      const header = await contractHeaderText(orcaPage)
      console.log(
        `HWF20_L1 states=${joinMap(l1States)} os=${measuredOs} gitVersion=${gitVersion} independent=${independent} contract=${api1.contractSource?.contentHash ?? 'none'} hostKey=${hostKey}`
      )
      expect(l1States).toEqual(SEEDED)
      expect(measuredOs).toBe('linux')
      expect(gitVersion).toBe(independent)
      expect(api1.contractSource?.contentHash).toBe(run.contractSha256)
      expect(header).toContain(hostKey)
      expect(header).toContain(run.contractSha256.slice(0, 8))

      // L3: the plan is rendered (station), the text changes on the host, the stale approval is refused.
      await expect(
        orcaPage.locator('[data-prepare-device-section] [data-prepare-run="shim"]')
      ).toBeVisible()
      expect(shimPresent(run)).toBe(false)
      editPrepare(run)
      const l3 = await approveAndRun(orcaPage, 'shim')
      const l3Shim = shimPresent(run)
      console.log(`HWF20_L3 reason=${l3.refusal ?? 'started'} shim=${l3Shim ? 'present' : 'no'}`)
      expect(l3.refusal).toBe('contract-changed')
      expect(l3Shim).toBe(false)

      // L4: an approval minted for this laptop's local host key is replayed against the GEX44 repo.
      const api4 = await measureThroughApi(orcaPage, repoId)
      captureJson(captureDir, 'measure-l4', api4)
      const shimRow = api4.requirements.find((r) => r.id === 'shim') as { prepare?: string }
      const localHostKey = `local@${hostKey.split('@').pop()}`
      const l4 = await invokeRunStep(orcaPage, {
        repoId,
        requirementId: 'shim',
        approvedContentHash: approvalHashFor('shim', localHostKey, shimRow.prepare ?? ''),
        approvedHostKey: localHostKey
      })
      captureJson(captureDir, 'run-l4', l4)
      const l4Shim = shimPresent(run)
      console.log(`HWF20_L4 reason=${l4.reason ?? l4.status} shim=${l4Shim ? 'present' : 'no'}`)
      expect(l4).toEqual({ status: 'refused', reason: 'approval-for-another-host' })
      expect(l4Shim).toBe(false)

      // L2: re-measure, approve the new bytes, the step starts; only a later Measure decides satisfied.
      expect(await measureNow(orcaPage)).toBe('rows')
      expect((await rowStates(orcaPage)).shim).toBe('needs-authorization')
      const l2 = await approveAndRun(orcaPage, 'shim')
      expect(l2.started).toBe(true)
      const tab = await pollHandle(
        () => terminalTabPresent(orcaPage, 'Prepare: shim'),
        (v) => v,
        30_000
      )
      const shimAfter = await pollHandle(
        async () => shimPresent(run),
        (v) => v,
        60_000
      )
      expect(shimAfter).toBe(true)
      const rowBefore = (await rowStates(orcaPage)).shim
      expect(await measureNow(orcaPage)).toBe('rows')
      const l2Row = (await rowStates(orcaPage)).shim
      const api2 = await measureThroughApi(orcaPage, repoId)
      captureJson(captureDir, 'measure-l2', api2)
      console.log(
        `HWF20_L2 terminal=${tab ? 'tab-present' : 'tab-absent'} started=yes shim=${shimAfter ? 'present' : 'absent'} row=${l2Row} decidedBy=remeasure rowBeforeRemeasure=${rowBefore ?? 'none'}`
      )
      expect(tab).toBe(true)
      expect(l2Row).toBe('satisfied')

      // L5: no copy of the host-side token reached this laptop.
      const l5States = await rowStates(orcaPage)
      captureJson(captureDir, 'store', await storeDump(orcaPage))
      const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
      const cli = runCliJson(['project', 'requirements', '--repo', `id:${repoId}`], userData)
      captureJson(captureDir, 'cli-requirements', cli)
      const scan = scanLaptopForContentNonces({
        roots: [
          { dir: userData },
          { dir: os.tmpdir(), modifiedSinceMs: startedAtMs - 60_000 },
          { dir: captureDir }
        ],
        nonces: [`HWF20TOK_${run.sentinelNonce}`],
        userDataRoot: userData
      })
      logAbsenceScan(scan)
      console.log(`HWF20_L5 envRow=${l5States.token} cli=${cli.ok ? 'ok' : 'unreachable'}`)
      expect(scan.verdict).toBe('PASS')
      expect(l5States.token).toBe('satisfied')

      // L6: with the carrier gone, a re-measure reads no observation, never absence.
      await carrier.kill()
      carrierDown = true
      const l6Outcome = await measureNow(orcaPage)
      const l6States = await rowStates(orcaPage)
      const l6Reasons = await rowReasons(orcaPage)
      const ids = Object.keys(l6States)
      const noObs = ids.filter(
        (id) => l6States[id] === 'unknown' && ['unreachable', 'timed-out'].includes(l6Reasons[id])
      )
      const missing = ids.filter((id) => l6States[id] === 'missing')
      const dist: Record<string, number> = {}
      for (const id of ids) {
        dist[l6Reasons[id]] = (dist[l6Reasons[id]] ?? 0) + 1
      }
      console.log(
        `HWF20_L6 rows=${ids.length} unknownNoObservation=${noObs.length} missing=${missing.length} reasons=${Object.entries(
          dist
        )
          .map(([k, v]) => `${k}:${v}`)
          .join(',')} outcome=${l6Outcome}`
      )
      expect(ids.length).toBeGreaterThan(0)
      expect(noObs.length).toBe(ids.length)
      expect(missing.length).toBe(0)
    } finally {
      if (carrierDown) {
        await carrier.restore().catch(() => undefined)
      }
      if (targetId) {
        await disconnectHwfTarget(orcaPage, targetId).catch(() => undefined)
      }
      await carrier.kill()
    }
  })

  test('old relay reads unknown', async ({ orcaPage }) => {
    test.skip(process.env.ORCA_HWF_P20_OLD_RELAY !== '1', 'needs ORCA_HWF_P20_OLD_RELAY=1')
    test.setTimeout(900_000)
    const run = asPrepareRun(readHwfRunFile())
    const localPort = readHwfLocalPort()
    await waitForSessionReady(orcaPage)
    const carrier = await startHwfCarrier(run, localPort)
    let targetId: string | null = null
    try {
      const connected = await connectHwfTargetWithTrust(orcaPage, run, localPort)
      targetId = connected.targetId
      const fence = await relayFence(run)
      const readBack = fence.remote.includes(`relay-${fence.local}`) ? fence.local : 'absent'
      console.log(`HWF20_O1_RELAY=${readBack} remote=${fence.remote.join(',')}`)
      expect(readBack).toBe(fence.local)
      await waitForSshConnected(orcaPage, targetId, { timeoutMs: 60_000 })
      const repoId = await addRemoteRepo(orcaPage, connected, run.projectPath, 'HWF20 old relay')
      await openPrepareSection(orcaPage, repoId)
      const outcome = await measureNow(orcaPage)
      const states = await rowStates(orcaPage)
      const reasons = await rowReasons(orcaPage)
      const ids = Object.keys(states)
      const predates = ids.filter(
        (id) => states[id] === 'unknown' && reasons[id] === 'host-predates-probes'
      )
      const missing = ids.filter((id) => states[id] === 'missing')
      console.log(
        `HWF20_O1 rows=${ids.length} unknownPredates=${predates.length} missing=${missing.length} outcome=${outcome}`
      )
      expect(ids.length).toBeGreaterThan(0)
      expect(predates.length).toBe(ids.length)
      expect(missing.length).toBe(0)
    } finally {
      if (targetId) {
        await disconnectHwfTarget(orcaPage, targetId).catch(() => undefined)
      }
      await carrier.kill()
    }
  })
})
