import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { startHwfCarrier } from './helpers/hwf-two-host-carrier'
import {
  addLocalReplica,
  asReplicaRun,
  waitForRootGrouping,
  waitForSshConnected
} from './helpers/hwf-two-host-replica-legs'
import {
  connectHwfTargetWithTrust,
  disconnectHwfTarget,
  hydrateHwfRemoteRepo,
  readHwfLocalPort,
  readHwfRunFile
} from './helpers/hwf-two-host-ssh-target'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import { worktreeRowSurface } from './worktree-row-locators'

/**
 * REAL-SSH rung for row 70: Continue here from the Working Sets dialog onto a GEX44 workspace reached
 * through a real SSH connection, then opening a restored row. Nothing is written into the store: the
 * laptop replica and the GEX44 replica share a root commit, so the app groups them into one project.
 * Legs: a really disconnected target refuses and applies nothing; reconnected, the same click
 * restores sleeping rows; opening one starts a shell on GEX44 in the remote workspace.
 * Not covered: a `reattach` disposition (needs a live provider session on the target).
 * Opt-in: a skip means NOT RUN.
 */

test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' || !process.env.ORCA_HWF_RUN_FILE,
  'needs ORCA_HWF_TWO_HOST=1 and ORCA_HWF_RUN_FILE (run-file --seed --local-seed); a skip is NOT RUN'
)

test.use({ orcaAppExtraEnv: { ORCA_RELAY_PATH: path.join(process.cwd(), 'out', 'relay') } })

const MISSING_PROFILE_ID = 'shell:e2e-profile-this-host-lacks'

async function tabCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() =>
    Object.fromEntries(
      Object.entries(window.__store!.getState().tabsByWorktree).map(([id, tabs]) => [
        id,
        tabs.length
      ])
    )
  )
}

async function sshStatus(page: Page, targetId: string): Promise<string> {
  return page.evaluate(
    (id) => window.__store!.getState().sshConnectionStates.get(id)?.status ?? 'absent',
    targetId
  )
}

async function continueHere(dialog: Locator): Promise<Locator> {
  await dialog.getByTestId('working-set-continue').click()
  const result = dialog.getByTestId('working-set-continue-result')
  await expect(result).toBeVisible({ timeout: 60_000 })
  return result
}

test('Continue here over a real SSH target: disconnected refuses, connected restores, Open starts a remote shell', async ({
  orcaPage: page
}) => {
  test.setTimeout(900_000)
  const run = asReplicaRun(readHwfRunFile())
  const remotePath = run.replicaPath
  const localPort = readHwfLocalPort()
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  const carrier = await startHwfCarrier(run, localPort)
  let targetId: string | null = null
  try {
    const connected = await connectHwfTargetWithTrust(page, run, localPort)
    targetId = connected.targetId
    await waitForSshConnected(page, targetId, { timeoutMs: 60_000 })
    // The laptop and GEX44 clones share a root commit, so the product itself makes them one project.
    const localRepoId = await addLocalReplica(page, run.localReplicaPath)
    const localWorktreeId = await page.evaluate(async (repoId) => {
      await window.__store!.getState().fetchWorktrees(repoId)
      const worktree = window.__store!.getState().worktreesByRepo[repoId]?.[0]
      if (!worktree) {
        throw new Error('the laptop replica has no worktree in the store')
      }
      window.__store!.getState().setActiveWorktree(worktree.id)
      return worktree.id
    }, localRepoId)
    const remote = await hydrateHwfRemoteRepo(page, connected, remotePath)
    // Why: the hydration helper opens a terminal on the remote workspace; Continue here needs it empty.
    await page.evaluate(
      ({ remoteWorktreeId, localId }) => {
        const s = window.__store!.getState()
        for (const tab of s.tabsByWorktree[remoteWorktreeId] ?? []) {
          s.closeTab(tab.id)
        }
        s.setActiveWorktree(localId)
      },
      { remoteWorktreeId: remote.worktreeId, localId: localWorktreeId }
    )
    // Station control for "nothing before": the remote workspace is empty and no remote PTY is bound.
    await expect
      .poll(async () => (await tabCounts(page))[remote.worktreeId] ?? 0, { timeout: 15_000 })
      .toBe(0)

    const grouped = await waitForRootGrouping(page, run.seedRoot, [localRepoId, remote.repoId])
    expect(grouped.hostIds).toContain('local')
    expect(grouped.hostIds.filter((id) => id.startsWith('ssh:')).length).toBe(1)
    console.log(
      `HWF70_PROJECT ${grouped.projectId} hosts=${grouped.hostIds.join(',')} waitedMs=${grouped.waitedMs}`
    )

    // A local workspace with a default, a missing-profile and a known-profile terminal, sealed by Save.
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)
    await page.evaluate(
      ({ wt, missing }) => {
        const s = window.__store!.getState()
        s.createTab(wt, undefined, undefined, { launchProfileId: 'shell:default' })
        s.createTab(wt, undefined, undefined, { launchProfileId: missing })
      },
      { wt: localWorktreeId, missing: MISSING_PROFILE_ID }
    )
    await expect
      .poll(
        () =>
          page.evaluate((wt) => {
            const s = window.__store!.getState()
            return (s.tabsByWorktree[wt] ?? []).filter((t) => s.terminalLayoutsByTabId[t.id]?.root)
              .length
          }, localWorktreeId),
        { timeout: 30_000 }
      )
      .toBe(3)
    await page.evaluate(() => {
      const s = window.__store!.getState()
      s.setRightSidebarOpen(false)
      s.setSidebarOpen(true)
    })
    await worktreeRowSurface(page, localWorktreeId).click({ button: 'right' })
    await page.getByTestId('worktree-menu-snapshots').click()
    const dialog = page.getByTestId('working-sets-dialog')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await dialog.getByTestId('working-set-save').click()
    await expect(dialog.getByTestId('working-set-save-result')).toHaveAttribute(
      'data-working-set-save-ok',
      'true',
      { timeout: 30_000 }
    )
    const workingSetId = await dialog
      .getByTestId('working-set-row')
      .first()
      .getAttribute('data-working-set-id')
    await dialog.locator(`[data-working-set-id="${workingSetId}"]`).click()
    await expect(dialog.locator('[data-working-set-preview-ready]')).toBeVisible({
      timeout: 60_000
    })
    await dialog.getByTestId('working-set-continue-target').click()
    const options = page.getByRole('option')
    await expect(options).toHaveCount(1)
    await options.first().click()
    await expect(dialog.getByTestId('working-set-continue')).toBeEnabled()

    // Leg 1: a really disconnected target. Mirror main's state only if the event path did not.
    const sshTarget = connected.targetId
    await disconnectHwfTarget(page, sshTarget)
    await expect
      .poll(
        async () => {
          if ((await sshStatus(page, sshTarget)) === 'connected') {
            await page.evaluate(async (id) => {
              const state = await window.api.ssh.getState({ targetId: id })
              if (state) {
                window.__store!.getState().setSshConnectionState(id, state)
              }
            }, sshTarget)
          }
          return sshStatus(page, sshTarget)
        },
        { timeout: 30_000 }
      )
      .toBe('disconnected')
    const before = await tabCounts(page)
    const refused = await continueHere(dialog)
    await expect(refused).toHaveAttribute('data-continue-status', 'refused')
    await expect(refused).toHaveAttribute('data-continue-tone', 'problem')
    await expect(dialog.getByTestId('working-set-continue-pane')).toHaveCount(0)
    expect(await tabCounts(page)).toEqual(before)
    console.log('HWF70_DISCONNECTED_REFUSED PASS')

    // Leg 2 (control): reconnect over the same carrier; the same click now restores.
    await page.evaluate(async (id) => {
      const state = await window.api.ssh.connect({ targetId: id })
      if (state) {
        window.__store!.getState().setSshConnectionState(id, state)
      }
    }, sshTarget)
    await waitForSshConnected(page, sshTarget, { timeoutMs: 60_000 })
    const restored = await continueHere(dialog)
    await expect(restored).toHaveAttribute('data-continue-status', 'restored')
    const panes = await dialog.getByTestId('working-set-continue-pane').evaluateAll((nodes) =>
      nodes.map((node) => {
        const el = node as HTMLElement
        return {
          paneKey: el.dataset.paneKey ?? '',
          disposition: el.dataset.paneDisposition ?? '',
          reason: el.dataset.paneReason ?? ''
        }
      })
    )
    console.log(`HWF70_PANES ${JSON.stringify(panes.map((p) => `${p.disposition}/${p.reason}`))}`)
    expect(panes.length).toBeGreaterThanOrEqual(3)
    expect(panes.map((p) => p.disposition)).toContain('restart')
    const dormant = await page.evaluate((wt) => {
      const s = window.__store!.getState()
      const tabs = s.tabsByWorktree[wt] ?? []
      return {
        count: tabs.length,
        dormant: tabs.filter((t) => t.dormancy?.reason === 'working-set-restore').length,
        withProcess: tabs.filter((t) => (s.ptyIdsByTabId[t.id] ?? []).length > 0).length
      }
    }, remote.worktreeId)
    expect(dormant.count).toBeGreaterThanOrEqual(3)
    expect(dormant.dormant).toBe(dormant.count)
    expect(dormant.withProcess).toBe(0)
    console.log(`HWF70_RESTORED ${JSON.stringify(dormant)}`)

    // Leg 3: Open on a restored row starts a shell on the owning host, in the remote workspace.
    const restartPane = panes.find((p) => p.disposition === 'restart')!
    const tabId = restartPane.paneKey.split(':')[0]
    await page.keyboard.press('Escape')
    await page.evaluate(
      ({ wt, id }) => {
        const s = window.__store!.getState()
        s.setActiveWorktree(wt)
        s.activateTab(id, { worktreeId: wt })
        s.setActiveTab(id)
      },
      { wt: remote.worktreeId, id: tabId }
    )
    await page
      .locator(`[data-dormant-terminal-tab-id="${tabId}"] [data-testid="dormant-terminal-open"]`)
      .click({ timeout: 30_000 })
    const ptyId = await waitForActivePanePtyId(page, 60_000)
    const nonce = randomBytes(4).toString('hex')
    const joined = `HWF70_${nonce}`
    const command = `printf '%s%s host=%s pwd=%s\\n' 'HWF70_' '${nonce}' "$(hostname)" "$(pwd)"`
    for (let attempt = 1; ; attempt += 1) {
      await execInTerminal(page, ptyId, command)
      try {
        await waitForTerminalOutput(page, `${joined} host=`, attempt < 3 ? 15_000 : 30_000)
        break
      } catch (error) {
        if (attempt >= 3) {
          throw error
        }
      }
    }
    const content = await getTerminalContent(page, 8000)
    const match = new RegExp(`${joined} host=(\\S+) pwd=(\\S+)`).exec(content)
    expect(match).not.toBeNull()
    expect(match![1]).toBe(run.hostname)
    expect(match![2]).toBe(remotePath)
    console.log(`HWF70_OPENED host=${match![1]} pwd=${match![2]}`)
  } finally {
    if (targetId) {
      await disconnectHwfTarget(page, targetId).catch(() => undefined)
    }
    await carrier.kill()
  }
})
