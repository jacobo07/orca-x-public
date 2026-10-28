import { readFileSync } from 'node:fs'
import path from 'node:path'

import { expect, test } from './helpers/orca-app'
import { runAgentLeg } from './helpers/hwf-two-host-reconnect-agent-leg'
import { runShellLeg } from './helpers/hwf-two-host-reconnect-legs'
import { bootHwfSession } from './helpers/hwf-two-host-session'

/**
 * REAL-TWO-HOST rung for phase 23 (matrix row 73): the laptop's ssh -L carrier to the GEX44 host drops and
 * returns; the laptop's own work continues and the return creates no second shell, relay or agent.
 * Opt-in: a skip means NOT RUN, never a pass.
 */

test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' || !process.env.ORCA_HWF_RUN_FILE,
  'needs ORCA_HWF_TWO_HOST=1 and ORCA_HWF_RUN_FILE (hwf-two-host-remote.mjs run-file, root from new-root --phase 23); a skip is NOT RUN'
)

test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: { ORCA_RELAY_PATH: path.join(process.cwd(), 'out', 'relay') }
})

function readProbe(): Record<string, string> {
  const file = process.env.ORCA_HWF_PROBE_FILE
  if (!file) {
    throw new Error('ORCA_HWF_PROBE_FILE is unset')
  }
  const values: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line)
    if (match) {
      values[match[1]] = match[2].trim()
    }
  }
  return values
}

test.describe.configure({ mode: 'serial' })

test.describe('two-host host loss and return', () => {
  test('local app keeps running through the drop and the shell is not duplicated', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(900_000)
    const session = await bootHwfSession(orcaPage, electronApp, { web: true })
    try {
      // Why: a renderer-side counter is the "other host" that must keep ticking while the SSH host is gone.
      await orcaPage.evaluate(() => {
        const w = window as unknown as { __hwfLocalTicks: number }
        w.__hwfLocalTicks = 0
        setInterval(() => {
          w.__hwfLocalTicks += 1
        }, 500)
      })
      const before = await orcaPage.evaluate(
        () => (window as unknown as { __hwfLocalTicks: number }).__hwfLocalTicks
      )
      // runShellLeg drops and restores the carrier, then asserts same shell pid, same relay, same process count.
      await runShellLeg(orcaPage, session)
      const after = await orcaPage.evaluate(
        () => (window as unknown as { __hwfLocalTicks: number }).__hwfLocalTicks
      )
      console.log(`HWF_LOCAL_CONTINUES before=${before} after=${after}`)
      expect(after).toBeGreaterThan(before + 10)
    } finally {
      await session.dispose()
    }
  })

  test('the agent is not duplicated after the return', async ({ orcaPage, electronApp }) => {
    test.setTimeout(900_000)
    const session = await bootHwfSession(orcaPage, electronApp, { web: true })
    try {
      await runAgentLeg(orcaPage, session, readProbe())
    } finally {
      await session.dispose()
    }
  })
})
