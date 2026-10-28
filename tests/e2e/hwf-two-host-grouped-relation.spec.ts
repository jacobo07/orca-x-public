import path from 'node:path'

import { expect, test } from './helpers/orca-app'
import { startHwfCarrier } from './helpers/hwf-two-host-carrier'
import { asReplicaRun } from './helpers/hwf-two-host-replica-legs'
import {
  connectHwfTargetWithTrust,
  disconnectHwfTarget,
  execOnOwningHost,
  readHwfLocalPort,
  readHwfRunFile
} from './helpers/hwf-two-host-ssh-target'
import { waitForSessionReady } from './helpers/store'

/**
 * REAL-TWO-HOST rung for row 60 (cross-host grouping with ancestry relation): the laptop connects to GEX44 over real SSH and the p17 replica
 * seeded by `hwf-two-host-remote.mjs seed-p17` is two commits ahead of the shared seed root. Opt-in: a skip means NOT RUN.
 * Scope: transport precondition + remote ahead count only. deriveReplicaTopology's relation (ahead/diverged) is
 * covered hermetically; feeding it from compareWithRelayReplica over the app's SSH relay is not wired, so this spec
 * does not claim the live relation. See the matrix reason for row 60.
 */

test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' || !process.env.ORCA_HWF_RUN_FILE || !process.env.ORCA_HWF_P17_PATH,
  'needs ORCA_HWF_TWO_HOST=1, ORCA_HWF_RUN_FILE and ORCA_HWF_P17_PATH (P17_REPLICA_PATH from seed-p17); a skip is NOT RUN'
)

test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: { ORCA_RELAY_PATH: path.join(process.cwd(), 'out', 'relay') }
})

test('row 60: GEX44 replica shares the seed root and is ahead of it (live leg for the grouped relation)', async ({ orcaPage }) => {
  test.setTimeout(900_000)
  const run = asReplicaRun(readHwfRunFile())
  const p17 = process.env.ORCA_HWF_P17_PATH as string
  expect(p17.startsWith('/tmp/orca-hwf-p17-')).toBe(true)
  await waitForSessionReady(orcaPage)
  const carrier = await startHwfCarrier(run, readHwfLocalPort())
  let targetId: string | null = null
  try {
    const connected = await connectHwfTargetWithTrust(orcaPage, run, readHwfLocalPort())
    targetId = connected.targetId
    console.log(`HWF60_PIN=${connected.pin}`)
    expect(connected.pin).toBe(run.fingerprint)
    const count = execOnOwningHost(run, `git -C ${p17} rev-list --count ${run.seedRoot}..HEAD`).out.trim()
    console.log(`HWF60_REMOTE_AHEAD=${count}`)
    expect(count).toBe('2')
  } finally {
    if (targetId) {
      await disconnectHwfTarget(orcaPage, targetId)
    }
    await carrier.kill()
  }
})
