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

/**
 * REAL-TWO-HOST rung for phase 22 (row 71): the GEX44 SSH target appears in the fleet observation as
 * measured (fresh, through the relay) while connected, and as unknown after disconnect.
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

type SshHost = {
  targetId: string
  outcome: 'measured' | 'unknown'
  observedAt: number
  answeredAt?: number
  relayUptimeMs?: number
  reason?: string
}

function sshHostsOf(userData: string): { hosts: SshHost[] | null; completedAt: number } {
  const r = runCliJson(['fleet', 'placement'], userData)
  if (!r.ok) {
    return { hosts: null, completedAt: 0 }
  }
  const body = (r.value.result ?? r.value) as {
    observation?: { completedAt: number; coverage?: { sshHosts?: SshHost[] } }
  }
  return {
    hosts: body.observation?.coverage?.sshHosts ?? null,
    completedAt: body.observation?.completedAt ?? 0
  }
}

test('GEX44 SSH target is measured through the relay, then unknown once disconnected', async ({
  orcaPage,
  electronApp
}) => {
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
    const before = Date.now()
    const live = await pollHandle(
      async () => sshHostsOf(userData).hosts?.find((h) => h.targetId === targetId),
      (h) => h?.outcome === 'measured',
      60_000
    )
    expect(live?.outcome).toBe('measured')
    expect(live!.answeredAt!).toBeGreaterThanOrEqual(before)
    expect(live!.relayUptimeMs!).toBeGreaterThanOrEqual(0)
    console.log(`HWF22_MEASURED target=${targetId} uptimeMs=${live!.relayUptimeMs} answeredAt=${live!.answeredAt}`)

    await disconnectHwfTarget(orcaPage, targetId)
    targetId = null
    const gone = await pollHandle(
      async () => sshHostsOf(userData).hosts?.find((h) => h.targetId === connected.targetId),
      (h) => h?.outcome === 'unknown',
      60_000
    )
    expect(gone?.outcome).toBe('unknown')
    expect(gone).not.toHaveProperty('relayUptimeMs')
    console.log(`HWF22_UNKNOWN target=${connected.targetId} reason=${gone?.reason}`)
  } finally {
    if (targetId) {
      await disconnectHwfTarget(orcaPage, targetId).catch(() => undefined)
    }
    await carrier.kill()
  }
})
