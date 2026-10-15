import { execFileSync } from 'node:child_process'
import path from 'node:path'

import type { Locator, Page } from '@stablyai/playwright-test'

import { expect, test } from './helpers/orca-app'
import { startHwfCarrier } from './helpers/hwf-two-host-carrier'
import {
  addLocalReplica,
  addRemoteRepo,
  asReplicaRun,
  readProjectView,
  waitForCondition,
  waitForRootGrouping,
  waitForSshConnected
} from './helpers/hwf-two-host-replica-legs'
import {
  openProjectHostSettings,
  pollHandle,
  stationReady
} from './helpers/hwf-two-host-replica-ui'
import {
  connectHwfTargetWithTrust,
  disconnectHwfTarget,
  execOnOwningHost,
  readHwfLocalPort,
  readHwfRunFile
} from './helpers/hwf-two-host-ssh-target'
import { waitForSessionReady } from './helpers/store'

/**
 * REAL-TWO-HOST leg for row 62 (LOCAL_RENDER): the rendered Settings relation row of a grouped SSH
 * replica, after a real click on Compare, over a live relay and then with the carrier down.
 * Reads data handles and digits only, so it holds in any UI locale. Opt-in: a skip means NOT RUN.
 */

const GATE_MISSING =
  process.env.ORCA_HWF_TWO_HOST !== '1' ||
  !process.env.ORCA_HWF_RUN_FILE ||
  !process.env.ORCA_HWF_P17_PATH
const GATE_MESSAGE =
  'needs ORCA_HWF_TWO_HOST=1, ORCA_HWF_RUN_FILE and ORCA_HWF_P17_PATH (P17_REPLICA_PATH from seed-p17); a skip is NOT RUN'

if (GATE_MISSING) {
  console.log(`HWF62_SETTINGS_RELATION NOT RUN: ${GATE_MESSAGE}`)
}
test.skip(GATE_MISSING, GATE_MESSAGE)

test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: { ORCA_RELAY_PATH: path.join(process.cwd(), 'out', 'relay') }
})

const P17_PREFIX = '/tmp/orca-hwf-p17-'
const COMPARE_TIMEOUT_MS = 120_000

// Optional: keep the rendered rows on disk, since a passing run does not retain its attachments.
function screenshotPath(name: string): { path?: string } {
  const dir = process.env.ORCA_HWF_SCREENSHOT_DIR
  return dir ? { path: path.join(dir, `hwf62-settings-relation-${name}.png`) } : {}
}

type RenderedRelation = {
  state: string | null
  tone: string | null
  text: string
  detail: string | null
}

async function readRelation(row: Locator): Promise<RenderedRelation> {
  const handle = row.locator('[data-replica-relation]').first()
  if ((await handle.count()) === 0) {
    return { state: null, tone: null, text: '', detail: null }
  }
  const detail = row.locator('[data-replica-relation-detail]').first()
  return {
    state: await handle.getAttribute('data-replica-relation'),
    tone: await handle.getAttribute('data-replica-relation-tone'),
    text: ((await handle.textContent()) ?? '').trim(),
    detail: (await detail.count()) > 0 ? ((await detail.textContent()) ?? '').trim() : null
  }
}

async function clickCompare(section: Locator): Promise<void> {
  const action = section.locator('[data-replica-compare-action]').first()
  await expect(action).toBeVisible({ timeout: 30_000 })
  await expect(action).toBeEnabled({ timeout: 30_000 })
  // A real click: a covered or disabled control must fail here, not read as "nothing changed".
  await action.click()
}

async function sshStatus(page: Page, targetId: string): Promise<string> {
  return page.evaluate(
    (id) => window.__store!.getState().sshConnectionStates.get(id)?.status ?? 'absent',
    targetId
  )
}

test('Settings renders the published relation after Compare, then unverified with the host down', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(1_200_000)
  const run = asReplicaRun(readHwfRunFile())
  const p17 = process.env.ORCA_HWF_P17_PATH as string
  expect(p17.startsWith(P17_PREFIX)).toBe(true)

  await waitForSessionReady(orcaPage)
  const carrier = await startHwfCarrier(run, readHwfLocalPort())
  const connected = await connectHwfTargetWithTrust(orcaPage, run, readHwfLocalPort()).catch(
    async (err) => {
      await carrier.kill()
      throw err
    }
  )
  try {
    expect(connected.pin).toBe(run.fingerprint)
    await waitForSshConnected(orcaPage, connected.targetId, { timeoutMs: 60_000 })

    // Both sides measured with git, so the expected relation is derived, never assumed.
    const remoteAhead = execOnOwningHost(
      run,
      `git -C ${p17} rev-list --count ${run.seedRoot}..HEAD`
    ).out.trim()
    const localAhead = execFileSync(
      'git',
      ['-C', run.localReplicaPath, 'rev-list', '--count', `${run.seedRoot}..HEAD`],
      { encoding: 'utf8' }
    ).trim()
    console.log(`HWF62_SIDES local_ahead=${localAhead} remote_ahead=${remoteAhead}`)
    expect(Number(remoteAhead)).toBeGreaterThan(0)
    const expectedState = localAhead === '0' ? 'behind' : 'diverged'

    const localRepoId = await addLocalReplica(orcaPage, run.localReplicaPath)
    const remoteRepoId = await addRemoteRepo(orcaPage, connected, p17, 'HWF62 p17')
    await waitForRootGrouping(orcaPage, run.seedRoot, [localRepoId, remoteRepoId])
    const setup = (await readProjectView(orcaPage)).setups.find((s) => s.repoId === remoteRepoId)
    expect(setup, 'no project setup for the SSH replica').toBeTruthy()
    const setupId = setup!.id

    await openProjectHostSettings(orcaPage, localRepoId)
    // Station control: the topology section holding the SSH row is visible before any read.
    const section = await stationReady(orcaPage, setupId)
    const row = section.locator(`[data-setup-id="${setupId}"]`).first()
    const before = await readRelation(row)
    console.log(`HWF62_BEFORE ${JSON.stringify(before)}`)

    await clickCompare(section)
    const live = await pollHandle(
      () => readRelation(row),
      (r) => r.state === expectedState,
      COMPARE_TIMEOUT_MS
    )
    console.log(`HWF62_LIVE ${JSON.stringify(live)}`)
    await testInfo.attach('settings-relation-live', {
      body: await section.screenshot(screenshotPath('live')),
      contentType: 'image/png'
    })
    expect(live.state).toBe(expectedState)
    expect(live.tone).toBe(expectedState === 'diverged' ? 'critical' : 'pressured')
    // The counts are digits in every locale; the rendered sentence must carry both measured sides.
    if (expectedState === 'diverged') {
      expect(live.text).toContain(`+${localAhead}`)
      expect(live.text).toContain(`-${remoteAhead}`)
    } else {
      expect(live.text).toContain(remoteAhead)
    }
    console.log('HWF62_LIVE PASS')

    await carrier.kill()
    const left = await waitForCondition(
      orcaPage,
      async () => {
        const status = await sshStatus(orcaPage, connected.targetId)
        return status === 'connected' ? null : status
      },
      async () => `status=${await sshStatus(orcaPage, connected.targetId)}`
    )
    console.log(`HWF62_SSH_STATE_AFTER_KILL=${left.value}`)

    await clickCompare(section)
    const down = await pollHandle(
      () => readRelation(row),
      (r) => r.state === 'unverified' && Boolean(r.detail),
      COMPARE_TIMEOUT_MS
    )
    console.log(`HWF62_DOWN ${JSON.stringify(down)}`)
    await testInfo.attach('settings-relation-down', {
      body: await section.screenshot(screenshotPath('down')),
      contentType: 'image/png'
    })
    // Unknown is never healthy: the row reads unverified with its closed reason, in the unknown tone.
    expect(down.state).toBe('unverified')
    expect(down.tone).toBe('unknown')
    expect(down.detail).toBeTruthy()
    console.log('HWF62_DOWN PASS')
  } finally {
    await disconnectHwfTarget(orcaPage, connected.targetId).catch((err) =>
      console.log(`HWF62_DISCONNECT_FAILED ${String(err).slice(0, 120)}`)
    )
    await carrier.kill()
  }
})
