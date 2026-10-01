import { execSync } from 'node:child_process'
import os from 'node:os'

import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

/**
 * First-contact SSH host-key trust, driven through the real dialog against a private sshd.
 *
 * 14-06 provides the sshd: ORCA_E2E_SSHD_PORT, ORCA_E2E_SSHD_KEY (client identity) and
 * ORCA_E2E_SSHD_FP (the sshd's SHA256 host-key fingerprint). The key-swap test additionally needs
 * ORCA_E2E_SSHD_SWAP_COMMAND (a shell command that replaces the host key and restarts that sshd)
 * and ORCA_E2E_SSHD_SWAPPED_FP (the fingerprint after the swap). A skip means NOT RUN, never a pass.
 */

const SSHD_PORT = Number(process.env.ORCA_E2E_SSHD_PORT ?? '0')
const SSHD_KEY = process.env.ORCA_E2E_SSHD_KEY ?? ''
const SSHD_FP = process.env.ORCA_E2E_SSHD_FP ?? ''
const SWAP_COMMAND = process.env.ORCA_E2E_SSHD_SWAP_COMMAND ?? ''
const SWAPPED_FP = process.env.ORCA_E2E_SSHD_SWAPPED_FP ?? ''
const SSHD_USER = process.env.ORCA_E2E_SSHD_USER ?? os.userInfo().username

type ConnectOutcome = { ok: true; status: string } | { ok: false; error: string }
type ConnectWindow = Window & { __hostKeyConnect?: Promise<ConnectOutcome> }

const DIALOG = '[data-ssh-host-key-trust-dialog]'

test.skip(
  !SSHD_PORT || !SSHD_KEY || !SSHD_FP,
  'needs a private sshd (ORCA_E2E_SSHD_PORT / _KEY / _FP, provided by 14-06)'
)

async function addSshdTarget(page: Page, label: string): Promise<string> {
  return page.evaluate(
    async ({ label, port, key, user }) => {
      const { target, repoReadoptions } = await window.api.ssh.addTarget({
        target: {
          label,
          host: '127.0.0.1',
          port,
          username: user,
          identityFile: key,
          // Why: without a source the target reads as ssh-config-backed and the label is resolved as the host.
          source: 'manual' as const,
          // Why: keep the relay short-lived if the app dies before cleanup.
          relayGracePeriodSeconds: 1
        }
      })
      window.__store?.getState().recordSshRepoReadoptions(repoReadoptions)
      return target.id
    },
    { label, port: SSHD_PORT, key: SSHD_KEY, user: SSHD_USER }
  )
}

// Why: the row is the station; assert it before any "no dialog" claim so a wrong pane cannot pass.
async function showTargetRow(page: Page, label: string): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('store unavailable')
    }
    state.openSettingsTarget({ pane: 'ssh', repoId: null })
    state.openSettingsPage()
  })
  await expect(
    page.locator(`[data-ssh-target-card][data-ssh-target-label="${label}"]`)
  ).toBeVisible({ timeout: 20_000 })
}

// Why: the connect promise stays open until the dialog is answered, so it is parked on window and read later.
async function startConnect(page: Page, targetId: string): Promise<void> {
  await page.evaluate((id) => {
    ;(window as ConnectWindow).__hostKeyConnect = window.api.ssh.connect({ targetId: id }).then(
      (state) => ({ ok: true as const, status: state.status }),
      (err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err)
      })
    )
  }, targetId)
}

async function connectOutcome(page: Page): Promise<ConnectOutcome> {
  return page.evaluate(async () => (window as ConnectWindow).__hostKeyConnect!)
}

async function pinOf(
  page: Page,
  targetId: string
): Promise<{ fingerprint: string; source: string } | null> {
  return page.evaluate(async (id) => {
    const targets = (await window.api.ssh.listTargets()) as {
      id: string
      hostKeyPin?: { fingerprint: string; source: string }
    }[]
    return targets.find((target) => target.id === id)?.hostKeyPin ?? null
  }, targetId)
}

test.describe('SSH host key trust', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('declining first contact leaves no pin and reports the key as not trusted', async ({
    orcaPage
  }) => {
    const label = `e2e-hostkey-deny-${Date.now()}`
    const targetId = await addSshdTarget(orcaPage, label)
    await showTargetRow(orcaPage, label)

    await startConnect(orcaPage, targetId)
    const dialog = orcaPage.locator(DIALOG)
    await expect(dialog).toBeVisible({ timeout: 60_000 })
    await expect(dialog).toHaveAttribute('data-target-id', targetId)
    await expect(dialog).toContainText(SSHD_FP)
    await dialog.locator('[data-action="deny"]').click()

    const outcome = await connectOutcome(orcaPage)
    expect(outcome.ok).toBe(false)
    expect(await pinOf(orcaPage, targetId)).toBeNull()
  })

  test('trusting first contact pins the key, connects, and a later connect asks nothing', async ({
    orcaPage
  }) => {
    test.slow()
    const label = `e2e-hostkey-trust-${Date.now()}`
    const targetId = await addSshdTarget(orcaPage, label)
    await showTargetRow(orcaPage, label)

    await startConnect(orcaPage, targetId)
    const dialog = orcaPage.locator(DIALOG)
    await expect(dialog).toBeVisible({ timeout: 60_000 })
    await expect(dialog).toContainText(SSHD_FP)
    await dialog.locator('[data-action="trust"]').click()

    expect(await connectOutcome(orcaPage)).toMatchObject({ ok: true, status: 'connected' })
    expect(await pinOf(orcaPage, targetId)).toMatchObject({
      fingerprint: SSHD_FP,
      source: 'tofu-confirmed'
    })

    // Positive control done (the dialog machinery demonstrably works); a pinned host must not ask again.
    await orcaPage.evaluate((id) => window.api.ssh.disconnect({ targetId: id }), targetId)
    await startConnect(orcaPage, targetId)
    expect(await connectOutcome(orcaPage)).toMatchObject({ ok: true, status: 'connected' })
    await expect(orcaPage.locator(DIALOG)).toHaveCount(0)
  })

  test('a swapped host key is refused with both fingerprints, no dialog, and the pin unchanged', async ({
    orcaPage
  }) => {
    test.skip(
      !SWAP_COMMAND || !SWAPPED_FP,
      'needs ORCA_E2E_SSHD_SWAP_COMMAND / _SWAPPED_FP (14-06)'
    )
    test.slow()
    const label = `e2e-hostkey-swap-${Date.now()}`
    const targetId = await addSshdTarget(orcaPage, label)
    await showTargetRow(orcaPage, label)

    await startConnect(orcaPage, targetId)
    const trustDialog = orcaPage.locator(DIALOG)
    await expect(trustDialog).toBeVisible({ timeout: 60_000 })
    await trustDialog.locator('[data-action="trust"]').click()
    expect(await connectOutcome(orcaPage)).toMatchObject({ ok: true })
    await orcaPage.evaluate((id) => window.api.ssh.disconnect({ targetId: id }), targetId)

    execSync(SWAP_COMMAND, { stdio: 'inherit', timeout: 60_000 })

    await startConnect(orcaPage, targetId)
    const outcome = await connectOutcome(orcaPage)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toContain(SSHD_FP)
      expect(outcome.error).toContain(SWAPPED_FP)
    }
    // Station: the target row is still on screen, so an absent dialog is a real absence.
    await expect(
      orcaPage.locator(`[data-ssh-target-card][data-ssh-target-label="${label}"]`)
    ).toBeVisible()
    await expect(orcaPage.locator(DIALOG)).toHaveCount(0)
    expect(await pinOf(orcaPage, targetId)).toMatchObject({ fingerprint: SSHD_FP })
  })
})
