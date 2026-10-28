/**
 * Real-app leg for row 70: a user opens Snapshots on a workspace, picks another host's setup of the
 * same project and chooses Continue here. The built app runs under xvfb on GEX44; there is no second
 * host, so the target setup, its workspace and its SSH availability are SEEDED in the renderer store.
 * Plane: REAL-APP / STORE-SEEDED-HOST. Everything asserted is read from data-* handles (the dialog
 * is localized) or from the store as an observer.
 *
 * Legs, each printing one `CONTINUE70_<LEG> PASS|FAIL` line:
 * - OFFER: nothing is offered with one setup (station control: the dialog is open); a ready second
 *   setup on another host makes the target picker appear (positive control).
 * - RESTORED: with the target connected the result reads restored, one pane row per sealed pane
 *   carries the planner's disposition and reason, the target workspace holds sleeping rows, and main
 *   lists no new session.
 * - UNVERIFIED-AND-DOWN: no SSH state reads as an unverified host (neutral tone), a disconnected host as
 *   a down one (problem tone), nothing is applied in either; a connected run on the same app is the
 *   control. The refused arm shows no pane rows, so the planner's host-unverified reason is not a
 *   DOM fact here; it is pinned hermetically in 03-01 and 03-07.
 * - TARGET-MISSING: a setup whose workspace is absent from the store is typed unavailable and no key
 *   is synthesized; seeding the workspace is the control.
 *
 * Not covered: a real ssh connection, a reattach to a live remote PTY, the folder-workspace refusal.
 */
import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActiveTerminalManager, waitForPaneCount } from './helpers/terminal'
import { worktreeRowSurface } from './worktree-row-locators'
import {
  CONTINUE_TARGET_SSH_TARGET_ID,
  seedSecondProjectSetup,
  seedTargetSshAvailability,
  seedTargetWorktree,
  type SeededTargetWorktree
} from './helpers/working-set-continue-seed'
import {
  planContinueOnHost,
  type ContinuePane
} from '../../src/shared/project-working-set-host-translation'
import { continueEvidenceOnTarget } from '../../src/shared/project-working-set-continue-evidence'
import type { ProjectWorkingSetManifest } from '../../src/shared/project-working-set-types'
import type { ProjectHostSetup } from '../../src/shared/project-types'

type DomPane = { leafId: string; disposition: string; reason: string }

const SEALED_TABS = 3
// Why these two: a known profile plans as relaunchable and a missing one as not runnable, so the
// table is not one repeated row that any constant answer would match.
const HOST_PROFILE_ID = 'shell:default'
const MISSING_PROFILE_ID = 'shell:e2e-profile-this-host-lacks'

const PLANNER_TARGET_STATE = { openTabCount: 0, hostAvailability: 'available' } as const

test.describe.configure({ mode: 'serial' })

/** One marker line per leg, so the evidence document can quote the run verbatim. */
async function leg(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Why built from the char code: Playwright colours assertion messages with ESC sequences.
    const detail = message
      .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
      .split('\n')[0]
    console.log(`CONTINUE70_${name} FAIL ${detail}`)
    throw error
  }
  console.log(`CONTINUE70_${name} PASS`)
}

async function openSnapshotsDialog(page: Page, worktreeId: string): Promise<Locator> {
  // Layout precondition: docked left, the side panel and the project list are alternatives.
  await page.evaluate(() => {
    const s = window.__store!.getState()
    s.setRightSidebarOpen(false)
    s.setSidebarOpen(true)
  })
  const card = worktreeRowSurface(page, worktreeId)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.click({ button: 'right' })
  await page.getByTestId('worktree-menu-snapshots').click()
  const dialog = page.getByTestId('working-sets-dialog')
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await expect(dialog.getByTestId('working-sets-state')).toHaveAttribute(
    'data-working-sets-state',
    'listed',
    { timeout: 15_000 }
  )
  return dialog
}

/** A workspace with three terminals (default, a host profile, a missing profile), saved through the dialog's own Save, with that snapshot selected. */
async function saveMixedSnapshot(page: Page): Promise<{
  worktreeId: string
  workingSetId: string
  dialog: Locator
}> {
  await waitForSessionReady(page)
  const worktreeId = await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneCount(page, 1, 30_000)
  await page.evaluate(
    ({ wt, known, missing }) => {
      const s = window.__store!.getState()
      s.createTab(wt, undefined, undefined, { launchProfileId: known })
      s.createTab(wt, undefined, undefined, { launchProfileId: missing })
    },
    { wt: worktreeId, known: HOST_PROFILE_ID, missing: MISSING_PROFILE_ID }
  )
  await expect
    .poll(
      () =>
        page.evaluate((wt) => {
          const s = window.__store!.getState()
          return (s.tabsByWorktree[wt] ?? []).filter(
            (tab) => s.terminalLayoutsByTabId[tab.id]?.root
          ).length
        }, worktreeId),
      { timeout: 30_000, message: 'three mounted terminals with layouts' }
    )
    .toBe(SEALED_TABS)
  const dialog = await openSnapshotsDialog(page, worktreeId)
  await dialog.getByTestId('working-set-save').click()
  await expect(dialog.getByTestId('working-set-save-result')).toHaveAttribute(
    'data-working-set-save-ok',
    'true',
    { timeout: 30_000 }
  )
  await expect(dialog.getByTestId('working-set-row')).toHaveCount(1, { timeout: 15_000 })
  const workingSetId = await dialog
    .getByTestId('working-set-row')
    .first()
    .getAttribute('data-working-set-id')
  expect(workingSetId).toBeTruthy()
  await dialog.locator(`[data-working-set-id="${workingSetId}"]`).click()
  await expect(dialog.locator('[data-working-set-preview-ready]')).toBeVisible({ timeout: 60_000 })
  return { worktreeId, workingSetId: workingSetId!, dialog }
}

/** The capabilities the dialog's own preview (real launch profiles) reports for the sealed set. */
async function previewCapabilities(dialog: Locator): Promise<string[]> {
  return (
    await dialog
      .locator('[data-working-set-capability]')
      .evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLElement).dataset.workingSetCapability ?? '')
      )
  ).sort()
}

async function mainSessionIds(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await window.api.pty.listSessions()).map((session) => session.id).sort()
  )
}

async function chooseOnlyTarget(page: Page, dialog: Locator): Promise<void> {
  await dialog.getByTestId('working-set-continue-target').click()
  const options = page.getByRole('option')
  await expect(options).toHaveCount(1)
  await options.first().click()
  await expect(dialog.getByTestId('working-set-continue')).toBeEnabled()
}

async function continueHere(dialog: Locator): Promise<Locator> {
  await dialog.getByTestId('working-set-continue').click()
  const result = dialog.getByTestId('working-set-continue-result')
  await expect(result).toBeVisible({ timeout: 60_000 })
  return result
}

async function readDomPanes(dialog: Locator): Promise<DomPane[]> {
  return dialog.getByTestId('working-set-continue-pane').evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const el = node as HTMLElement
        return {
          leafId: (el.dataset.paneKey ?? '').split(':').slice(1).join(':'),
          disposition: el.dataset.paneDisposition ?? '',
          reason: el.dataset.paneReason ?? ''
        }
      })
      .sort((a, b) => a.leafId.localeCompare(b.leafId))
  )
}

async function targetTabs(
  page: Page,
  targetWorktreeId: string
): Promise<{ count: number; dormantByRestore: number; withProcess: number }> {
  return page.evaluate((wt) => {
    const s = window.__store!.getState()
    const tabs = s.tabsByWorktree[wt] ?? []
    return {
      count: tabs.length,
      dormantByRestore: tabs.filter((tab) => tab.dormancy?.reason === 'working-set-restore').length,
      withProcess: tabs.filter((tab) => (s.ptyIdsByTabId[tab.id] ?? []).length > 0).length
    }
  }, targetWorktreeId)
}

/** Every workspace's tab count, so "no new row anywhere" is a comparison and not a recollection. */
async function allTabCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const s = window.__store!.getState()
    return Object.fromEntries(
      Object.entries(s.tabsByWorktree).map(([worktreeId, tabs]) => [worktreeId, tabs.length])
    )
  })
}

/** The planner's table for the sealed manifest, from facts read through the app's own bridge. */
async function plannerPanes(
  page: Page,
  args: {
    worktreeId: string
    workingSetId: string
    targetWorktree: SeededTargetWorktree
    targetSetup: ProjectHostSetup
  }
): Promise<{ panes: ContinuePane[]; sealedPaneCount: number; capabilities: string[] }> {
  const facts = await page.evaluate(async ({ worktreeId, workingSetId }) => {
    const scope = { executionHostId: 'local' as const, ownerKey: worktreeId }
    const read = (await window.api.workingSet.read({ scope, workingSetId })) as {
      status: string
      manifest?: unknown
    }
    const probed = (await window.api.workingSet.probeRestoreEvidence({ scope, workingSetId })) as {
      status: string
      evidence?: unknown
    }
    const s = window.__store!.getState()
    const sourceSetup = s.projectHostSetups.find((setup) => setup.hostId === 'local')
    return { read, probed, sourceSetup }
  }, args)
  expect(facts.read.status).toBe('valid')
  expect(facts.sourceSetup).toBeTruthy()
  const manifest = facts.read.manifest as ProjectWorkingSetManifest
  let counter = 0
  const planned = planContinueOnHost(
    manifest,
    {
      projectId: args.targetSetup.projectId,
      sourceSetup: facts.sourceSetup!,
      targetSetup: args.targetSetup,
      targetOwnerKey: args.targetWorktree.worktreeId
    },
    {
      // Why null: the seeded SSH target has no filesystem, so no session copy is read back there.
      evidence: continueEvidenceOnTarget(
        facts.probed.status === 'probed' ? (facts.probed.evidence as never) : null,
        null
      ),
      launchProfiles: [{ id: HOST_PROFILE_ID }],
      presence: {},
      target: PLANNER_TARGET_STATE,
      newTabId: () => `planner-tab-${counter++}`
    }
  )
  expect(planned.kind).toBe('planned')
  if (planned.kind !== 'planned') {
    return { panes: [], sealedPaneCount: 0, capabilities: [] }
  }
  return {
    capabilities: [
      ...new Set(
        planned.plan.entries.flatMap((entry) =>
          entry.panes.map((pane) => pane.restoreTime.capability as string)
        )
      )
    ].sort(),
    panes: planned.panes,
    sealedPaneCount: manifest.entries.reduce((sum, entry) => sum + entry.panes.length, 0)
  }
}

async function targetSetupOf(page: Page): Promise<ProjectHostSetup> {
  return page.evaluate(
    (hostId) => window.__store!.getState().projectHostSetups.find((s) => s.hostId === hostId)!,
    `ssh:${CONTINUE_TARGET_SSH_TARGET_ID}`
  )
}

test('OFFER: Continue here is offered only when another host holds a ready setup', async ({
  orcaPage
}) => {
  await leg('OFFER', async () => {
    const { worktreeId, dialog } = await saveMixedSnapshot(orcaPage)
    // Station control: the dialog and its Restore handle are present, so the zero below is about
    // the continue surface and not about a dialog that never rendered.
    await expect(dialog.getByTestId('working-set-restore')).toBeVisible()
    await expect(dialog.getByTestId('working-set-save')).toBeVisible()
    await expect(dialog.getByTestId('working-set-continue-section')).toHaveCount(0)
    await expect(dialog.getByTestId('working-set-continue')).toHaveCount(0)

    // Positive control: the same dialog, a ready second setup on another host.
    await seedSecondProjectSetup(orcaPage, worktreeId)
    await expect(dialog.getByTestId('working-set-continue-section')).toBeVisible({
      timeout: 15_000
    })
    await expect(dialog.getByTestId('working-set-continue-target')).toBeVisible()
    // Disabled until a host is chosen: nothing is preselected.
    await expect(dialog.getByTestId('working-set-continue')).toBeDisabled()
  })
})

test('RESTORED: Continue here onto a connected host leaves sleeping rows and starts nothing', async ({
  orcaPage
}) => {
  await leg('RESTORED', async () => {
    const { worktreeId, workingSetId, dialog } = await saveMixedSnapshot(orcaPage)
    await seedSecondProjectSetup(orcaPage, worktreeId)
    const targetWorktree = await seedTargetWorktree(orcaPage, worktreeId)
    await seedTargetSshAvailability(orcaPage, 'connected')
    const targetSetup = await targetSetupOf(orcaPage)

    const baselineSessions = await mainSessionIds(orcaPage)
    const sourceBefore = await targetTabs(orcaPage, worktreeId)
    // Station control for "nothing before": the target workspace exists and is empty.
    expect(await targetTabs(orcaPage, targetWorktree.worktreeId)).toEqual({
      count: 0,
      dormantByRestore: 0,
      withProcess: 0
    })

    await chooseOnlyTarget(orcaPage, dialog)
    const result = await continueHere(dialog)
    await expect(result).toHaveAttribute('data-continue-status', 'restored')

    const expected = await plannerPanes(orcaPage, {
      worktreeId,
      workingSetId,
      targetWorktree,
      targetSetup
    })
    expect(expected.sealedPaneCount).toBeGreaterThanOrEqual(SEALED_TABS)
    // The planner here is run with a guessed profile list; it is the app's own only if the two
    // agree on what the sealed panes can do on this host.
    expect(expected.capabilities).toEqual(await previewCapabilities(dialog))
    const domPanes = await readDomPanes(dialog)
    // One row per sealed pane, each carrying the planner's disposition and reason.
    expect(domPanes).toHaveLength(expected.sealedPaneCount)
    expect(domPanes).toEqual(
      expected.panes
        .map((pane) => ({
          leafId: pane.leafId,
          disposition: pane.disposition,
          reason: pane.reason
        }))
        .sort((a, b) => a.leafId.localeCompare(b.leafId))
    )
    console.log(
      `CONTINUE70_PANES ${JSON.stringify(domPanes.map((p) => `${p.disposition}/${p.reason}`))}`
    )

    // Sleeping rows in the target workspace, nothing running anywhere new.
    const target = await targetTabs(orcaPage, targetWorktree.worktreeId)
    expect(target.count).toBeGreaterThanOrEqual(SEALED_TABS)
    expect(target.dormantByRestore).toBe(target.count)
    expect(target.withProcess).toBe(0)
    await expect.poll(() => mainSessionIds(orcaPage), { timeout: 5_000 }).toEqual(baselineSessions)
    // The source workspace is left as it was.
    expect(await targetTabs(orcaPage, worktreeId)).toEqual(sourceBefore)
    // The dialog stays open so the table can be read.
    await expect(dialog).toBeVisible()
  })
})

test('UNVERIFIED-AND-DOWN: an unmeasured or disconnected host applies nothing', async ({
  orcaPage
}) => {
  await leg('UNVERIFIED-AND-DOWN', async () => {
    const { worktreeId, dialog } = await saveMixedSnapshot(orcaPage)
    await seedSecondProjectSetup(orcaPage, worktreeId)
    const targetWorktree = await seedTargetWorktree(orcaPage, worktreeId)
    await chooseOnlyTarget(orcaPage, dialog)
    const tabCountsBefore = await allTabCounts(orcaPage)
    const baselineSessions = await mainSessionIds(orcaPage)

    // No SSH state at all: the host is unmeasured, which is neither down nor available. The refused
    // arm lists no pane rows, so the distinction is read from the result's tone and sentence.
    await seedTargetSshAvailability(orcaPage, 'absent')
    let result = await continueHere(dialog)
    await expect(result).toHaveAttribute('data-continue-status', 'refused')
    await expect(result).toHaveAttribute('data-continue-tone', 'neutral')
    const unverifiedSentence = await result.locator('p').first().innerText()
    // Station control for the zero below: the result surface itself is on screen.
    await expect(result).toBeVisible()
    await expect(dialog.getByTestId('working-set-continue-pane')).toHaveCount(0)
    expect(await allTabCounts(orcaPage)).toEqual(tabCountsBefore)

    // A disconnected host is a measured fact, and reads differently.
    await seedTargetSshAvailability(orcaPage, 'disconnected')
    result = await continueHere(dialog)
    await expect(result).toHaveAttribute('data-continue-status', 'refused')
    await expect(result).toHaveAttribute('data-continue-tone', 'problem')
    const downSentence = await result.locator('p').first().innerText()
    expect(downSentence.length).toBeGreaterThan(0)
    expect(downSentence).not.toEqual(unverifiedSentence)
    expect(await allTabCounts(orcaPage)).toEqual(tabCountsBefore)
    expect(await mainSessionIds(orcaPage)).toEqual(baselineSessions)

    // Control: the same app and snapshot, host connected, does create rows. Without it the zeros
    // above could be a Continue that never reaches apply.
    await seedTargetSshAvailability(orcaPage, 'connected')
    result = await continueHere(dialog)
    await expect(result).toHaveAttribute('data-continue-status', 'restored')
    expect((await targetTabs(orcaPage, targetWorktree.worktreeId)).count).toBeGreaterThanOrEqual(
      SEALED_TABS
    )
  })
})

test('TARGET-MISSING: a setup whose workspace is not in the store is typed, not synthesized', async ({
  orcaPage
}) => {
  await leg('TARGET-MISSING', async () => {
    const { worktreeId, dialog } = await saveMixedSnapshot(orcaPage)
    await seedSecondProjectSetup(orcaPage, worktreeId)
    await seedTargetSshAvailability(orcaPage, 'connected')
    await chooseOnlyTarget(orcaPage, dialog)
    const tabCountsBefore = await allTabCounts(orcaPage)

    const result = await continueHere(dialog)
    await expect(result).toHaveAttribute('data-continue-status', 'continue-target-unavailable')
    // Station control for the zero: the result surface rendered, with its pane table empty by design.
    await expect(result).toBeVisible()
    await expect(dialog.getByTestId('working-set-continue-pane')).toHaveCount(0)
    expect(await allTabCounts(orcaPage)).toEqual(tabCountsBefore)
    const synthesized = await orcaPage.evaluate(
      () =>
        Object.keys(window.__store!.getState().tabsByWorktree).filter((key) =>
          key.includes('e2e-continue-target')
        ).length
    )
    expect(synthesized).toBe(0)

    // Control: seeding the workspace turns the same click into a restore under the seeded key.
    const targetWorktree = await seedTargetWorktree(orcaPage, worktreeId)
    const again = await continueHere(dialog)
    await expect(again).toHaveAttribute('data-continue-status', 'restored')
    expect((await targetTabs(orcaPage, targetWorktree.worktreeId)).count).toBeGreaterThanOrEqual(
      SEALED_TABS
    )
  })
})
