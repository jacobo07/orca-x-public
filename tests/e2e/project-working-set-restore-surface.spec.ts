/**
 * Product reality for the snapshots surface: a user saves a workspace's terminals from its menu,
 * relaunches Orca, finds the snapshot listed from disk in the same menu, and restores it.
 *
 * What this proves, all through the UI (the store is used only to set up tabs and to observe):
 * - Save and Restore reach the real store and the canonical restore; the list survives a restart.
 * - The preview is judged against this host's real launch profiles: a `shell:cmd.exe` row can be
 *   recreated, a row naming a profile this host lacks cannot, and neither is left unknown.
 * - A preview taken on an empty workspace does not authorize restoring after a tab appears.
 * - Two clicks in one turn restore once; rows keep their order and identity with a repeated title.
 * - Restore navigates to the workspace and starts nothing: no row has a process and main lists no
 *   new session through activation, selection of every row, leaving and returning. Only the
 *   placeholder's Open starts a row, one per click.
 * - Reopening the dialog on the now-populated workspace refuses and changes nothing.
 *
 * Not covered: the fixture seeds the provider session and points codex at `echo`; the workspace is
 * emptied through the store (closing tabs is not what is under test).
 */
import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { waitForActiveTerminalManager, waitForPaneCount } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

type LocalScope = { executionHostId: 'local'; ownerKey: string }

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __workingSetE2E?: {
      save: (request: { ownerKey: string; label?: string | null }) => Promise<unknown>
      list: (scope: LocalScope) => Promise<unknown>
      restore: (request: { scope: LocalScope; workingSetId: string }) => Promise<unknown>
    }
  }
}

const PROVIDER_SESSION_ID = 'e2e-working-set-surface-session'
const SHARED_LABEL = 'Build'
const MISSING_PROFILE = 'shell:e2e-profile-this-host-lacks'

type RowSnapshot = { id: string; title: string; leafId: string | null }

async function readRows(page: Page, worktreeId: string): Promise<RowSnapshot[]> {
  return page.evaluate((wt) => {
    const s = window.__store!.getState()
    const order = (s.groupsByWorktree[wt] ?? []).flatMap((group) => group.tabOrder)
    const byId = new Map((s.tabsByWorktree[wt] ?? []).map((tab) => [tab.id, tab]))
    return order
      .filter((id) => byId.has(id))
      .map((id) => {
        const root = s.terminalLayoutsByTabId[id]?.root
        return {
          id,
          title: byId.get(id)!.customTitle ?? byId.get(id)!.title,
          leafId: root?.type === 'leaf' ? root.leafId : null
        }
      })
  }, worktreeId)
}

async function openTabCount(page: Page, worktreeId: string): Promise<number> {
  return page.evaluate((wt) => {
    const s = window.__store!.getState()
    return (s.tabsByWorktree[wt]?.length ?? 0) + (s.unifiedTabsByWorktree[wt]?.length ?? 0)
  }, worktreeId)
}

async function emptyWorkspace(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((wt) => {
    const s = window.__store!.getState()
    for (const tab of s.tabsByWorktree[wt] ?? []) {
      s.closeTab(tab.id)
    }
  }, worktreeId)
  await expect
    .poll(() => openTabCount(page, worktreeId), {
      timeout: 15_000,
      message: 'workspace did not empty'
    })
    .toBe(0)
}

async function liveRowIds(page: Page, worktreeId: string, ids: string[]): Promise<string[]> {
  return page.evaluate(
    ({ wt, tabIds }) => {
      const s = window.__store!.getState()
      const present = new Set((s.tabsByWorktree[wt] ?? []).map((tab) => tab.id))
      return tabIds.filter((id) => present.has(id) && (s.ptyIdsByTabId[id] ?? []).length > 0)
    },
    { wt: worktreeId, tabIds: ids }
  )
}

async function mainSessionIds(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await window.api.pty.listSessions()).map((session) => session.id).sort()
  )
}

async function selectRow(page: Page, worktreeId: string, tabId: string): Promise<void> {
  const dormant = await page.evaluate(
    ({ wt, id }) => {
      const s = window.__store!.getState()
      s.activateTab(id, { worktreeId: wt })
      s.setActiveTab(id)
      const tab = (s.tabsByWorktree[wt] ?? []).find((candidate) => candidate.id === id)
      return Boolean(tab?.dormancy) && !tab?.dormantOpenRequested
    },
    { wt: worktreeId, id: tabId }
  )
  if (dormant) {
    await expect(page.getByTestId('dormant-terminal-placeholder')).toHaveAttribute(
      'data-dormant-terminal-tab-id',
      tabId,
      { timeout: 15_000 }
    )
  }
}

/** Every sample: exactly `live` rows have a process, and every new main session belongs to one. */
async function expectHeldFor(
  page: Page,
  worktreeId: string,
  ids: string[],
  expected: { live: string[]; baseline: string[] }
): Promise<void> {
  const violations: string[] = []
  for (let sample = 0; sample < 16; sample++) {
    const live = await liveRowIds(page, worktreeId, ids)
    if (JSON.stringify(live) !== JSON.stringify(expected.live)) {
      violations.push(`sample ${sample}: live rows ${JSON.stringify(live)}`)
    }
    const stray = await page.evaluate(
      async ({ baseline, opened }) => {
        const s = window.__store!.getState()
        const allowed = new Set(opened.flatMap((id) => s.ptyIdsByTabId[id] ?? []))
        const known = new Set(baseline)
        return (await window.api.pty.listSessions())
          .map((session) => session.id)
          .filter((id) => !known.has(id) && !allowed.has(id))
      },
      { baseline: expected.baseline, opened: expected.live }
    )
    if (stray.length > 0) {
      violations.push(`sample ${sample}: main sessions not bound to an opened row ${stray}`)
    }
    await page.waitForTimeout(250)
  }
  expect(violations).toEqual([])
}

/** The user's route: right-click the workspace in the sidebar, choose Snapshots…. */
async function openSnapshotsDialog(page: Page, worktreeId: string) {
  const card = page.locator(`[data-worktree-drag-id="${worktreeId}"]`).first()
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.click({ button: 'right' })
  await page.getByTestId('worktree-menu-snapshots').click()
  const dialog = page.getByTestId('working-sets-dialog')
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await expect(dialog.getByTestId('working-sets-state')).not.toHaveAttribute(
    'data-working-sets-state',
    'loading',
    { timeout: 15_000 }
  )
  return dialog
}

async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('working-sets-dialog')).toHaveCount(0, { timeout: 10_000 })
}

async function selectSnapshot(page: Page, workingSetId: string): Promise<void> {
  const dialog = page.getByTestId('working-sets-dialog')
  await dialog.locator(`[data-working-set-id="${workingSetId}"]`).click()
  await expect(dialog.locator('[data-working-set-preview-ready]')).toBeVisible({
    timeout: 60_000
  })
}

async function previewFacts(page: Page) {
  const dialog = page.getByTestId('working-sets-dialog')
  return {
    capabilities: (
      await dialog
        .locator('[data-working-set-capability]')
        .evaluateAll((nodes) =>
          nodes.map((node) => (node as HTMLElement).dataset.workingSetCapability)
        )
    ).sort(),
    blockers: await dialog
      .locator('[data-working-set-blocker]')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.workingSetBlocker))
  }
}

test.describe.configure({ mode: 'serial' })

test('saves and restores a workspace snapshot through its menu, starting nothing until opened', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }

  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const first = await session.launch()
    firstApp = first.app
    const page = await firstApp.firstWindow()
    const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)

    await page.evaluate(
      ({ wt, missing }) => {
        const s = window.__store!.getState()
        s.createTab(wt, undefined, 'cmd.exe', { launchProfileId: 'shell:cmd.exe' })
        s.createTab(wt, undefined, undefined, { launchProfileId: missing })
      },
      { wt: worktreeId, missing: MISSING_PROFILE }
    )
    await expect
      .poll(async () => (await readRows(page, worktreeId)).filter((row) => row.leafId).length, {
        timeout: 30_000,
        message: 'three mounted terminals with layouts'
      })
      .toBe(3)
    const created = await readRows(page, worktreeId)
    await page.evaluate(
      ({ ids, label }) => {
        const s = window.__store!.getState()
        for (const id of ids) {
          s.setTabCustomTitle(id, label)
        }
      },
      { ids: [created[1].id, created[2].id], label: SHARED_LABEL }
    )
    const transcriptPath = session.seedCodexResumeRollout(PROVIDER_SESSION_ID, repoPath)
    await page.evaluate(
      ({ paneKey, wt, id, transcriptPath: path }) => {
        window
          .__store!.getState()
          .setAgentStatus(
            paneKey,
            { state: 'done', prompt: '', agentType: 'codex' },
            'Codex',
            undefined,
            { worktreeId: wt },
            { providerSession: { key: 'session_id', id, transcriptPath: path } }
          )
      },
      {
        paneKey: `${created[0].id}:${created[0].leafId}`,
        wt: worktreeId,
        id: PROVIDER_SESSION_ID,
        transcriptPath
      }
    )

    // Save through the menu.
    let dialog = await openSnapshotsDialog(page, worktreeId)
    await expect(dialog.getByTestId('working-sets-state')).toHaveAttribute(
      'data-working-sets-state',
      'listed'
    )
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
    await closeDialog(page)
    const savedLabels = created.map((row, index) => (index === 0 ? row.title : SHARED_LABEL))

    await emptyWorkspace(page, worktreeId)
    await session.close(firstApp)
    firstApp = null

    const second = await session.launch()
    secondApp = second.app
    const page2 = second.page
    await waitForSessionReady(page2)
    await page2.evaluate(() =>
      window.__store!.getState().updateSettings({ agentCmdOverrides: { codex: 'echo' } })
    )
    await emptyWorkspace(page2, worktreeId)

    // Listed from disk by a fresh process, and the store agrees on the id.
    dialog = await openSnapshotsDialog(page2, worktreeId)
    await expect(dialog.getByTestId('working-set-row')).toHaveCount(1)
    await expect(dialog.getByTestId('working-set-row').first()).toHaveAttribute(
      'data-working-set-id',
      workingSetId!
    )
    const stored = await page2.evaluate(
      (wt) => window.__workingSetE2E!.list({ executionHostId: 'local', ownerKey: wt }),
      worktreeId
    )
    expect(
      (stored as { valid: { workingSetId: string }[] }).valid.map((m) => m.workingSetId)
    ).toEqual([workingSetId])

    // Judged against this host's real launch profiles.
    await selectSnapshot(page2, workingSetId!)
    expect(await previewFacts(page2)).toEqual({
      capabilities: ['exact-resume', 'not-restorable', 'recreate-context'],
      blockers: []
    })

    // A clean preview does not authorize restoring over a tab that appeared afterwards.
    const userTabId = await page2.evaluate(
      (wt) => window.__store!.getState().createTab(wt).id,
      worktreeId
    )
    await dialog.getByTestId('working-set-restore').click()
    await expect(dialog.getByTestId('working-set-restore-result')).toBeVisible({
      timeout: 30_000
    })
    await expect(dialog.locator('[data-working-set-blocker="current-work-present"]')).toBeVisible()
    expect((await readRows(page2, worktreeId)).map((row) => row.id)).toEqual([userTabId])
    await expect(dialog.getByTestId('working-set-restore')).toBeDisabled()

    await emptyWorkspace(page2, worktreeId)
    // Choosing the row again re-plans against the emptied workspace.
    await selectSnapshot(page2, workingSetId!)
    await expect
      .poll(async () => (await previewFacts(page2)).blockers, { timeout: 30_000 })
      .toEqual([])
    // Before the restore, so nothing the restore or activation starts can hide in the baseline.
    const baseline = await mainSessionIds(page2)

    // Two clicks in one turn.
    await dialog.getByTestId('working-set-restore').evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
    await expect(page2.getByTestId('working-sets-dialog')).toHaveCount(0, { timeout: 60_000 })

    const rows = await readRows(page2, worktreeId)
    expect(rows.map((row) => row.title)).toEqual(savedLabels)
    expect(new Set(rows.map((row) => row.id)).size).toBe(3)
    expect(rows.map((row) => row.leafId)).toEqual(created.map((row) => row.leafId))
    const ids = rows.map((row) => row.id)
    expect(
      await page2.evaluate(
        ({ wt, tabIds }) => {
          const s = window.__store!.getState()
          return {
            activeWorktreeId: s.activeWorktreeId,
            dormant: (s.tabsByWorktree[wt] ?? [])
              .filter((tab) => tabIds.includes(tab.id))
              .every((tab) => tab.dormancy?.reason === 'working-set-restore'),
            openRequested: (s.tabsByWorktree[wt] ?? []).filter((tab) => tab.dormantOpenRequested)
              .length
          }
        },
        { wt: worktreeId, tabIds: ids }
      )
    ).toEqual({ activeWorktreeId: worktreeId, dormant: true, openRequested: 0 })

    // Restore navigated there; the selected row is dormant and shows its placeholder.
    await ensureTerminalVisible(page2)
    await expect(page2.getByTestId('dormant-terminal-placeholder')).toBeVisible({
      timeout: 30_000
    })
    await expectHeldFor(page2, worktreeId, ids, { live: [], baseline })
    for (const id of ids) {
      await selectRow(page2, worktreeId, id)
    }
    await expectHeldFor(page2, worktreeId, ids, { live: [], baseline })

    // Only Open starts a row.
    await selectRow(page2, worktreeId, ids[0])
    await page2.getByTestId('dormant-terminal-open').click()
    await expect
      .poll(() => liveRowIds(page2, worktreeId, ids), {
        timeout: 45_000,
        message: 'only the opened row acquired a process'
      })
      .toEqual([ids[0]])
    await expectHeldFor(page2, worktreeId, ids, { live: [ids[0]], baseline })

    // Leave, then come back through the sidebar card.
    await page2.evaluate(() => window.__store!.getState().setActiveWorktree(null))
    await page2.locator(`[data-worktree-drag-id="${worktreeId}"]`).first().click()
    await waitForActiveWorktree(page2)
    await ensureTerminalVisible(page2)
    await selectRow(page2, worktreeId, ids[1])
    await expectHeldFor(page2, worktreeId, ids, { live: [ids[0]], baseline })

    await page2.getByTestId('dormant-terminal-open').click()
    await expect
      .poll(() => liveRowIds(page2, worktreeId, ids), {
        timeout: 45_000,
        message: 'the second opened row acquired a process'
      })
      .toEqual([ids[0], ids[1]])
    await expectHeldFor(page2, worktreeId, ids, { live: [ids[0], ids[1]], baseline })

    // The workspace now holds the restored rows: the dialog refuses and nothing changes.
    dialog = await openSnapshotsDialog(page2, worktreeId)
    await selectSnapshot(page2, workingSetId!)
    expect((await previewFacts(page2)).blockers).toEqual(['current-work-present'])
    await expect(dialog.getByTestId('working-set-restore')).toBeDisabled()
    await closeDialog(page2)
    expect((await readRows(page2, worktreeId)).map((row) => row.id)).toEqual(ids)

    const after = await mainSessionIds(page2)
    console.log(
      `[restore-surface-evidence] rows=${ids.length} baseline=${baseline.length} ` +
        `newMainSessionsAfterTwoOpens=${after.filter((id) => !baseline.includes(id)).length} ` +
        `liveRows=${(await liveRowIds(page2, worktreeId, ids)).length}`
    )
  } finally {
    if (secondApp) {
      await session.close(secondApp)
    }
    if (firstApp) {
      await session.close(firstApp)
    }
    await session.dispose()
  }
})
