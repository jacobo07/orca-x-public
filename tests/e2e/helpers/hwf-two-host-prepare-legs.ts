import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { expect, type Locator, type Page } from '@stablyai/playwright-test'

import { prepareApprovalPreimage } from '../../../src/shared/environment-prepare-plan'
import type { EnvironmentRequirementsMeasurement } from '../../../src/shared/environment-requirements-measurement'
import { resolveSshHostIdentityStatus } from '../../../src/shared/ssh-host-key-pin-shape'
import { openProjectHostSettings } from './hwf-two-host-replica-ui'
import { execOnOwningHost, type HwfRun } from './hwf-two-host-ssh-target'

// Data handles only: the e2e host runs a Spanish locale, so no visible text is asserted.

// Written by `hwf-two-host-remote.mjs run-file --seed20 --sentinel-nonce`.
export type HwfPrepareRun = HwfRun & {
  projectPath: string
  contractSha256: string
  shimDir: string
  sentinelNonce: string
}

export function asPrepareRun(run: HwfRun): HwfPrepareRun {
  const r = run as Partial<HwfPrepareRun>
  for (const key of ['projectPath', 'contractSha256', 'shimDir', 'sentinelNonce'] as const) {
    if (!r[key]) {
      throw new Error(`ORCA_HWF_RUN_FILE is missing ${key} (run-file --seed20 --sentinel-nonce)`)
    }
  }
  return run as HwfPrepareRun
}

/** Station control: the section is visible before any row or count is read. */
export async function openPrepareSection(page: Page, repoId: string): Promise<Locator> {
  await openProjectHostSettings(page, repoId)
  const section = page.locator('[data-prepare-device-section]')
  await expect(section).toHaveCount(1, { timeout: 60_000 })
  await expect(section).toBeVisible({ timeout: 60_000 })
  return section
}

function block(page: Page): Locator {
  return page.locator('[data-prepare-device-section] [data-prepare-host-block]').first()
}

export type MeasureOutcome = 'rows' | 'failed' | 'host-predates'

/** The person's Measure click (PD-22); waits for the measuring state, then for an outcome handle. */
export async function measureNow(page: Page): Promise<MeasureOutcome> {
  const button = block(page).locator('[data-prepare-measure]')
  await expect(button).toBeEnabled({ timeout: 60_000 })
  // An observer installed before the click catches the measuring state even if React commits it a tick later.
  const sawMeasuring = await button.evaluate(async (el) => {
    const button = el as HTMLButtonElement
    let seen = false
    const observer = new MutationObserver(() => {
      seen ||= button.disabled
    })
    observer.observe(button, { attributes: true })
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    observer.disconnect()
    return seen || button.disabled
  })
  expect(sawMeasuring).toBe(true)
  await expect(button).toBeEnabled({ timeout: 120_000 })
  const outcome = block(page).locator(
    '[data-requirement-state], [data-prepare-measure-failed], [data-prepare-host-predates]'
  )
  await expect(outcome.first()).toBeVisible({ timeout: 30_000 })
  if ((await block(page).locator('[data-prepare-measure-failed]').count()) > 0) {
    return 'failed'
  }
  if ((await block(page).locator('[data-prepare-host-predates]').count()) > 0) {
    return 'host-predates'
  }
  return 'rows'
}

async function readRowAttr(page: Page, attr: string): Promise<Record<string, string>> {
  return block(page)
    .locator('[data-requirement-id]')
    .evaluateAll(
      (rows, name) =>
        Object.fromEntries(
          rows.map((row) => [
            row.getAttribute('data-requirement-id') ?? '',
            row.getAttribute(name) ?? ''
          ])
        ),
      attr
    )
}

export function rowStates(page: Page): Promise<Record<string, string>> {
  return readRowAttr(page, 'data-requirement-state')
}

export function rowReasons(page: Page): Promise<Record<string, string>> {
  return readRowAttr(page, 'data-requirement-reason')
}

export async function contractHeaderText(page: Page): Promise<string> {
  return (await block(page).locator('[data-prepare-contract-source]').textContent()) ?? ''
}

export async function refusalOf(page: Page): Promise<string | null> {
  const note = block(page).locator('[data-prepare-refusal]')
  return (await note.count()) > 0 ? note.first().getAttribute('data-prepare-refusal') : null
}

export type PrepareRunSignal = 'marker' | 'terminal-activated' | 'refused'

/**
 * Review and run -> approval dialog -> Approve. Resolves on the started marker, a refusal handle, or
 * (Run 3) the activated `Prepare: <id>` terminal: the runner creates that terminal only after
 * authorizing, and activating it leaves Settings, so the section's own marker unmounts with it.
 */
export async function approveAndRun(
  page: Page,
  requirementId: string
): Promise<{ started: boolean; signal: PrepareRunSignal; refusal: string | null }> {
  await block(page).locator(`[data-prepare-run="${requirementId}"]`).click()
  const dialog = page.locator('[data-prepare-approval-dialog]')
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await expect(dialog).toHaveAttribute('data-requirement-id', requirementId)
  await dialog.locator('[data-prepare-approve]').click()
  const marker = block(page).locator(`[data-prepare-step-started="${requirementId}"]`)
  const refusal = block(page).locator('[data-prepare-refusal]')
  const title = `Prepare: ${requirementId}`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if ((await marker.count()) > 0) {
      return { started: true, signal: 'marker', refusal: null }
    }
    if ((await refusal.count()) > 0) {
      return { started: false, signal: 'refused', refusal: await refusalOf(page) }
    }
    const sectionGone = (await page.locator('[data-prepare-device-section]').count()) === 0
    if (sectionGone && (await terminalTabPresent(page, title))) {
      return { started: true, signal: 'terminal-activated', refusal: null }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`no started marker, refusal or ${title} terminal within 60 s`)
}

export async function measureThroughApi(
  page: Page,
  repoId: string
): Promise<EnvironmentRequirementsMeasurement> {
  return page.evaluate((id) => window.api.environment.measureRequirements({ repoId: id }), repoId)
}

export async function invokeRunStep(
  page: Page,
  args: {
    repoId: string
    requirementId: string
    approvedContentHash: string
    approvedHostKey: string
  }
): Promise<{ status: string; reason?: string }> {
  return page.evaluate((a) => window.api.environment.runPrepareStep(a), args)
}

/** The same preimage the plan builder hashes, for a host key the caller chooses. */
export function approvalHashFor(requirementId: string, hostKey: string, bytes: string): string {
  return createHash('sha256')
    .update(prepareApprovalPreimage(requirementId, hostKey, bytes))
    .digest('hex')
}

export function captureJson(dir: string, name: string, value: unknown): void {
  writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`)
}

function remoteKeyValues(out: string): Record<string, string> {
  return Object.fromEntries(
    out
      .split(/\r?\n/)
      .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1], m[2]])
  )
}

/** REAL-SSH instrument on the owning host, independent of Orca. */
export function shimPresent(run: HwfPrepareRun): boolean {
  const r = execOnOwningHost(
    run,
    '[ -f home/p20-bin/orca-hwf-p20-shim ] && echo SHIM_PRESENT=yes || echo SHIM_PRESENT=no'
  )
  const kv = remoteKeyValues(r.out)
  if (kv.SHIM_PRESENT !== 'yes' && kv.SHIM_PRESENT !== 'no') {
    throw new Error(`shim stat failed: ${r.out.slice(0, 200)}`)
  }
  return kv.SHIM_PRESENT === 'yes'
}

export function independentGitVersion(run: HwfPrepareRun): string {
  const r = execOnOwningHost(run, 'git --version')
  const m = /git version (\S+)/.exec(r.out)
  if (!m) {
    throw new Error(`independent git read failed: ${r.out.slice(0, 200)}`)
  }
  return m[1]
}

/** Rewrites the shim prepare on GEX44 through the committed driver verb; the parsed value must change. */
export function editPrepare(run: HwfPrepareRun): { contractSha256: string } {
  const driver = path.join(process.cwd(), 'config', 'scripts', 'hwf-two-host-remote.mjs')
  const r = spawnSync(process.execPath, [driver, 'edit-prepare-p20', run.root], {
    encoding: 'utf8',
    timeout: 60_000
  })
  const kv = remoteKeyValues(`${r.stdout ?? ''}`)
  if (r.status !== 0 || !kv.CONTRACT_SHA256 || kv.PREPARE_SHA256 === kv.PREPARE_SHA256_BEFORE) {
    throw new Error(`edit-prepare-p20 failed: ${r.stdout}${r.stderr}`)
  }
  return { contractSha256: kv.CONTRACT_SHA256 }
}

/** A store read of the terminal tabs (named `tab-present`), never a rendered observation. */
export async function terminalTabPresent(page: Page, titlePrefix: string): Promise<boolean> {
  return page.evaluate((prefix) => {
    const state = window.__store!.getState()
    return Object.values(state.tabsByWorktree).some((tabs) =>
      tabs.some((tab) =>
        [tab.title, tab.customTitle, tab.defaultTitle].some(
          (t) => typeof t === 'string' && t.startsWith(prefix)
        )
      )
    )
  }, titlePrefix)
}

/**
 * The identity the prepare authority reads: the product's resolver over the saved target and main's
 * live state. Runs 1-2 measured that the public live state carries no hostIdentity of its own.
 */
export async function liveHostIdentity(
  page: Page,
  targetId: string
): Promise<{ identity: string; live: string }> {
  const inputs = await page.evaluate(async (id) => {
    const targets = (await window.api.ssh.listTargets()) as {
      id: string
      host: string
      port: number
      hostKeyPin?: unknown
    }[]
    const target = targets.find((t) => t.id === id)
    const live = (await window.api.ssh.getState({ targetId: id }))?.hostIdentity
    return {
      target: target
        ? { host: target.host, port: target.port, hostKeyPin: target.hostKeyPin }
        : null,
      live: live ?? null
    }
  }, targetId)
  return {
    identity: inputs.target
      ? resolveSshHostIdentityStatus(inputs.target, inputs.live ?? undefined)
      : 'absent',
    live: inputs.live ?? 'absent'
  }
}

export async function storeDump(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const state = window.__store!.getState()
    return {
      repos: state.repos,
      trustedOrcaHooks: state.trustedOrcaHooks,
      sshConnectionStates: [...state.sshConnectionStates.entries()]
    }
  })
}
