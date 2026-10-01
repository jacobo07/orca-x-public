/**
 * DWS-P2 desktop attach helper (CTX-CLI-1, CTX-EXP-2). Drives the real
 * `AddRemoteHostDialog` ("server" mode) to pair the laptop desktop with a remote Orca runtime
 * over the SSH-tunnel checkbox path.
 *
 * This IS the criterion-3 attach proof: `verifyAndAddFromPairingCode` performs a live
 * `status.get` round-trip over the tunnel BEFORE saving (runtime-environment-pairing-verification.ts),
 * so the dialog closing successfully is itself evidence the tunnel round-trip succeeded.
 *
 * Never logs, titles, or throws with the raw pairing URL -- only `pairingSha12` (T-02-04d).
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { returnToAppShell } from './ssh-config-host-picker'
import { waitForSessionReady } from './store'

type PairingFileShape = {
  pairing?: { pairingUrl?: string; pairingSha12?: string }
}

export type AttachDwsRemoteRuntimeOptions = {
  name: string
  pairingFile: string
}

export type AttachDwsRemoteRuntimeResult = {
  environmentId: string
  pairingSha12: string
}

function readPairingFile(pairingFile: string): { pairingUrl: string; pairingSha12: string } {
  const raw = readFileSync(pairingFile, 'utf8')
  const parsed = JSON.parse(raw) as PairingFileShape
  const pairingUrl = parsed.pairing?.pairingUrl
  if (!pairingUrl) {
    throw new Error(
      `attachDwsRemoteRuntime: pairing file "${pairingFile}" carries no pairing.pairingUrl`
    )
  }
  const pairingSha12 = createHash('sha256').update(pairingUrl, 'utf8').digest('hex').slice(0, 12)
  return { pairingUrl, pairingSha12 }
}

/**
 * Reaches AddRemoteHostDialog (server mode) through the product's own navigation: Add Project ->
 * Host combobox -> Add remote host -> Add remote server. Mirrors
 * `openAddSshHostDialog` in ./ssh-config-host-picker.ts, which proves the sibling "Add SSH host"
 * leg of the same popover chain.
 */
export async function attachDwsRemoteRuntime(
  orcaPage: Page,
  opts: AttachDwsRemoteRuntimeOptions
): Promise<AttachDwsRemoteRuntimeResult> {
  const { pairingUrl, pairingSha12 } = readPairingFile(opts.pairingFile)

  await waitForSessionReady(orcaPage)
  // Why: this host's OS locale is not guaranteed to be English (AGENTS.md), and this spec's later
  // steps (Task 1/2 UI navigation reused from tests/e2e/pr11346-selected-runtime-add.spec.ts) match
  // dialog/button text. Force the same locale CI runs under rather than teaching every downstream
  // locator a translation-independent handle.
  await orcaPage.evaluate(() => window.__store?.getState().updateSettings({ uiLanguage: 'en' }))
  await returnToAppShell(orcaPage)

  // Why openModal('add-repo') directly, not clicking a button by text: the "Add Project" button's
  // accessible name is translated (this host's OS locale is not guaranteed to be English --
  // AGENTS.md), and this drives the exact same code path the button's own onClick calls.
  await orcaPage.evaluate(() => window.__store?.getState().openModal('add-repo'))
  // Pinned by id for the same reason as serverDialog below: `.last()` is live and this dialog
  // stays mounted underneath the remote-server dialog stacked on top of it.
  const addProjectDialogLast = orcaPage.getByRole('dialog').last()
  await expect(addProjectDialogLast).toBeVisible({ timeout: 10_000 })
  const addProjectDialogId = await addProjectDialogLast.getAttribute('id')
  if (!addProjectDialogId) {
    throw new Error('attachDwsRemoteRuntime: the Add Project dialog rendered with no id to pin against')
  }
  const addProjectDialog = orcaPage.locator(`#${addProjectDialogId}`)

  const hostCombobox = addProjectDialog.getByRole('combobox')
  await expect(hostCombobox).toBeVisible()
  await hostCombobox.click()

  // The nested popovers below are Radix portals (not necessarily inside addProjectDialog's DOM
  // subtree), and their labels are translated -- locate them by the data-testid hooks added
  // alongside this plan instead (AddRepoHostSelector.tsx).
  const addRemoteHostItem = orcaPage.getByTestId('add-remote-host-menu-item')
  await expect(addRemoteHostItem).toBeVisible({ timeout: 5_000 })
  await addRemoteHostItem.click()

  const addRemoteServerAction = orcaPage.getByTestId('add-remote-server-action')
  await expect(addRemoteServerAction).toBeVisible({ timeout: 5_000 })
  await addRemoteServerAction.click()

  // `.last()` is a LIVE locator that re-resolves on every use. addProjectDialog stays mounted and
  // open underneath this one, so once THIS dialog closes, `.last()` re-matches addProjectDialog
  // (still visible) and `toBeHidden` below would wait for a dialog that was never this one --
  // measured: 15 consecutive re-resolutions to a *different* dialog id all reporting "visible".
  // Pin to this dialog's own id the moment it appears so the later toBeHidden targets the same node.
  const serverDialogLast = orcaPage.getByRole('dialog').last()
  await expect(serverDialogLast).toBeVisible({ timeout: 10_000 })
  const serverDialogId = await serverDialogLast.getAttribute('id')
  if (!serverDialogId) {
    throw new Error('attachDwsRemoteRuntime: the remote-server dialog rendered with no id to pin against')
  }
  const serverDialog = orcaPage.locator(`#${serverDialogId}`)

  await serverDialog.locator('#add-server-name').fill(opts.name)
  await serverDialog.locator('#add-server-pairing-code').fill(pairingUrl)

  // Station control: the loopback destination box must render, identified by a data-* handle
  // (never translated text -- the E2E host is not guaranteed to run in English), BEFORE the
  // SSH-tunnel checkbox is touched.
  const destinationBox = serverDialog.locator('[data-add-server-link-destination]')
  await expect(destinationBox).toBeVisible({ timeout: 10_000 })
  await expect(destinationBox).toHaveAttribute('data-add-server-link-destination', 'loopback')

  await serverDialog.getByRole('checkbox').click()
  await serverDialog.getByTestId('add-remote-server-save').click()

  // The dialog cannot close without verifyAndAddFromPairingCode's live status.get round-trip
  // succeeding -- this IS the criterion-3 attach proof.
  await expect(serverDialog).toBeHidden({ timeout: 20_000 })
  await orcaPage.keyboard.press('Escape')
  await expect(addProjectDialog).toBeHidden({ timeout: 10_000 }).catch(() => undefined)

  const found = await orcaPage.evaluate((name) => {
    const state = window.__store?.getState()
    const env = state?.runtimeEnvironments.find((candidate) => candidate.name === name)
    if (!env) {
      return null
    }
    const status = state?.runtimeStatusByEnvironmentId.get(env.id)
    return {
      id: env.id,
      connectionDependency: env.connectionDependency ?? null,
      status: status?.status ?? null
    }
  }, opts.name)

  if (!found) {
    throw new Error(
      `attachDwsRemoteRuntime: environment "${opts.name}" not found in the desktop store after save (pairingSha12=${pairingSha12})`
    )
  }
  if (found.connectionDependency !== 'ssh-tunnel') {
    throw new Error(
      `attachDwsRemoteRuntime: environment "${opts.name}" saved without connectionDependency=ssh-tunnel (got ${String(found.connectionDependency)}, pairingSha12=${pairingSha12})`
    )
  }
  if (!found.status) {
    throw new Error(
      `attachDwsRemoteRuntime: environment "${opts.name}" has no recorded runtime status after save (pairingSha12=${pairingSha12})`
    )
  }

  return { environmentId: found.id, pairingSha12 }
}
