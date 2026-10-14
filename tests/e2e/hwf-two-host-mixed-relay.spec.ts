import { spawnSync } from 'node:child_process'
import path from 'node:path'

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
