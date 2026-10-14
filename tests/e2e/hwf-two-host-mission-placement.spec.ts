import path from 'node:path'

import { expect, test } from './helpers/orca-app'
import { startHwfCarrier } from './helpers/hwf-two-host-carrier'
import { runCliJson, waitForSshConnected } from './helpers/hwf-two-host-replica-legs'
import { pollHandle } from './helpers/hwf-two-host-replica-ui'
import {
  connectHwfTargetWithTrust,
  disconnectHwfTarget,
  readHwfLocalPort,
  readHwfRunFile
} from './helpers/hwf-two-host-ssh-target'
import { waitForSessionReady } from './helpers/store'
import { planMissionPlacement } from '../../src/shared/mission-job-placement'

/**
 * REAL-TWO-HOST rung for phase 22 (row 72): with the GEX44 SSH target connected, the fleet placement
 * proposal holds two distinct eligible hosts, and a two-job mission is planned onto both (one job each).
 * Opt-in: a skip means NOT RUN.
 */

test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' || !process.env.ORCA_HWF_RUN_FILE,
  'needs ORCA_HWF_TWO_HOST=1 and ORCA_HWF_RUN_FILE (hwf-two-host-remote.mjs run-file --seed --local-seed); a skip is NOT RUN'
)

test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: { ORCA_RELAY_PATH: path.join(process.cwd(), 'out', 'relay') }
})

type Candidate = { key: string; fingerprint: string; label: string; evidenceAddress: string }

let lastProposal = ''

function eligibleOf(userData: string): Candidate[] {
  const r = runCliJson(['fleet', 'placement'], userData)
  if (!r.ok) {
    lastProposal = `unreachable: ${r.unreachable}`
    return []
  }
  const body = (r.value.result ?? r.value) as { proposal?: { eligible?: Candidate[]; rejected?: unknown } }
  // Why: a count of 1 alone cannot say which host was rejected or why.
  lastProposal = JSON.stringify({ eligible: body.proposal?.eligible, rejected: body.proposal?.rejected })
  return body.proposal?.eligible ?? []
}

test('two jobs of one mission are placed on two distinct hosts', async ({ orcaPage, electronApp }) => {
  test.setTimeout(900_000)
  const run = readHwfRunFile()
  const localPort = readHwfLocalPort()
  await waitForSessionReady(orcaPage)
  const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const carrier = await startHwfCarrier(run, localPort)
  let targetId: string | null = null
  try {
    const connected = await connectHwfTargetWithTrust(orcaPage, run, localPort)
    targetId = connected.targetId
    await waitForSshConnected(orcaPage, targetId, { timeoutMs: 60_000 })
    const eligible = await pollHandle(
      async () => eligibleOf(userData),
      (e) => new Set(e.map((c) => c.key)).size >= 2,
      60_000
    )
    console.log(`HWF22_PROPOSAL=${lastProposal}`)
    expect(new Set(eligible.map((c) => c.key)).size).toBeGreaterThanOrEqual(2)
    // Plan from the live proposal: the members below only restate the eligible hosts.
    const members = eligible.map((c) => ({
      address: c.evidenceAddress,
      label: c.label,
      fingerprint: c.fingerprint,
      sample: { availableMemory: 1, platform: 'any', capabilities: [] }
    }))
    const plan = planMissionPlacement(
      [{ jobId: 'job-a' }, { jobId: 'job-b' }],
      members as never,
      {} as never
    )
    expect(plan.hostCount).toBe(2)
    for (const p of plan.placements) {
      console.log(`HWF22_PLACED job=${p.jobId} host=${p.hostKey} label=${p.label}`)
    }
    console.log(`HWF22_CROSSHOST hosts=${plan.hostCount}`)
  } finally {
    if (targetId) {
      await disconnectHwfTarget(orcaPage, targetId).catch(() => undefined)
    }
    await carrier.kill()
  }
})
