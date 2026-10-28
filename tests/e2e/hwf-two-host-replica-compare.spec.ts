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
 * REAL-TWO-HOST rung for phase 17 (row 63): the laptop connects to GEX44 over real SSH and the p17 replica
 * seeded by `hwf-two-host-remote.mjs seed-p17` is two commits ahead of the shared seed root. Opt-in: a skip means NOT RUN.
 * Scope: transport precondition only. The comparison service is not yet wired to the app's SSH relay session,
 * so this spec does not claim the compare result; see the matrix reason for row 63.
 */

test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' || !process.env.ORCA_HWF_RUN_FILE || !process.env.ORCA_HWF_P17_PATH,
  'needs ORCA_HWF_TWO_HOST=1, ORCA_HWF_RUN_FILE and ORCA_HWF_P17_PATH (P17_REPLICA_PATH from seed-p17); a skip is NOT RUN'
)

test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: { ORCA_RELAY_PATH: path.join(process.cwd(), 'out', 'relay') }
})

test('p17 replica on GEX44 is reachable over SSH and ahead of the seed root', async ({ orcaPage }) => {
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
    console.log(`HWF17_PIN=${connected.pin}`)
    expect(connected.pin).toBe(run.fingerprint)
    const count = execOnOwningHost(run, `git -C ${p17} rev-list --count ${run.seedRoot}..HEAD`).out.trim()
    console.log(`HWF17_REMOTE_AHEAD=${count}`)
    expect(count).toBe('2')
  } finally {
    if (targetId) {
      await disconnectHwfTarget(orcaPage, targetId)
    }
    await carrier.kill()
  }
})
