/**
 * Product reality for W4 and W6: a working set saved through the real capture path is read back from
 * disk by a relaunched app and restored into its (emptied) workspace.
 *
 * What this proves: the manifest survives the creator's lifecycle; restore rebuilds the rail by
 * identity (two rows sharing a label stay two rows) in the sealed order; the apply step itself
 * starts no terminal. Then (W6): with the restored workspace open and every row selected in turn,
 * no row has a process and main lists no new PTY; opening the sealed agent row through the
 * placeholder starts exactly that row and its cold restore consumes the resume record; leaving and
 * re-entering the workspace wakes nothing; a second open adds exactly one more.
 *
 * Until W6 the tail of this test measured the opposite (every row acquired a process on
 * activation). It was inverted in place rather than replaced.
 *
 * What it does not cover: the fixture itself seeds the provider session (no agent CLI runs) and
 * points the codex command at `echo`, and it empties the workspace before restoring — the app has
 * no product surface for either step yet.
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

const PROVIDER_SESSION_ID = 'e2e-working-set-session'
const SHARED_LABEL = 'Build'

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

async function emptyWorkspace(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((wt) => {
    const s = window.__store!.getState()
    // closeTab replaces the array in the store, so this snapshot is safe to walk.
    for (const tab of s.tabsByWorktree[wt] ?? []) {
      s.closeTab(tab.id)
    }
  }, worktreeId)
  await expect
    .poll(
      () =>
        page.evaluate((wt) => {
          const s = window.__store!.getState()
          return (s.tabsByWorktree[wt]?.length ?? 0) + (s.unifiedTabsByWorktree[wt]?.length ?? 0)
        }, worktreeId),
      { timeout: 15_000, message: 'workspace did not empty' }
    )
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

async function resumeHandleCount(page: Page, worktreeId: string): Promise<number> {
  return page.evaluate(
    (wt) =>
      Object.values(window.__store!.getState().sleepingAgentSessionsByPaneKey).filter(
        (record) => record.worktreeId === wt
      ).length,
    worktreeId
  )
}

async function mainSessionIds(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await window.api.pty.listSessions()).map((session) => session.id).sort()
  )
}

async function expectBoundInMain(page: Page, tabId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const bound = window.__store!.getState().ptyIdsByTabId[id] ?? []
          const live = new Set((await window.api.pty.listSessions()).map((session) => session.id))
          return bound.some((ptyId) => live.has(ptyId))
        }, tabId),
      { timeout: 30_000, message: `main does not list the PTY bound to ${tabId}` }
    )
    .toBe(true)
}

/** Programmatic selection, then proof the render pass ran: a dormant row shows its placeholder. */
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

/**
 * An absence is only evidence over a window. Samples for a few seconds after a render has been
 * observed. Every sample must show exactly `live` rows with a process, and every main session
 * that did not exist at `baseline` must be bound to one of those rows. A set difference rather
 * than a count: sessions closed before the baseline can still be exiting, and a count let two new
 * PTYs hide behind two dying ones in the drill that proved this.
 */
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

test.describe.configure({ mode: 'serial' })

test('restores a saved working set from disk after a restart, by identity and in order', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
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

    await page.evaluate((wt) => {
      const s = window.__store!.getState()
      s.createTab(wt)
      s.createTab(wt)
    }, worktreeId)
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

    // Hermetic stand-in for an agent's hook report: the same store entry a real run produces.
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

    const saved = await page.evaluate(
      (wt) => window.__workingSetE2E!.save({ ownerKey: wt, label: 'e2e' }),
      worktreeId
    )
    expect(saved).toMatchObject({ status: 'saved' })
    const workingSetId = (saved as { workingSetId: string }).workingSetId
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
    // Whatever the relaunch opened on its own is not the working set; restore needs an empty target.
    await emptyWorkspace(page2, worktreeId)
    // Before the restore, so nothing the restore or activation starts can hide in the baseline.
    const baseline = await mainSessionIds(page2)

    const scope = { executionHostId: 'local' as const, ownerKey: worktreeId }
    const history = await page2.evaluate((s) => window.__workingSetE2E!.list(s), scope)
    expect(history).toMatchObject({ status: 'listed' })
    const listedIds = (history as { valid: { workingSetId: string }[] }).valid.map(
      (manifest) => manifest.workingSetId
    )
    expect(listedIds).toContain(workingSetId)

    const restored = await page2.evaluate(
      async ({ s, id }) => {
        const outcome = await window.__workingSetE2E!.restore({ scope: s, workingSetId: id })
        // Read in the same turn as the apply: nothing has rendered yet.
        const state = window.__store!.getState()
        const tabs = state.tabsByWorktree[s.ownerKey] ?? []
        return {
          outcome,
          ptyIdsRightAfterApply: tabs.flatMap((tab) => state.ptyIdsByTabId[tab.id] ?? []),
          resumeHandles: Object.values(state.sleepingAgentSessionsByPaneKey)
            .filter((record) => tabs.some((tab) => tab.id === record.tabId))
            .map((record) => record.providerSession.id)
        }
      },
      { s: scope, id: workingSetId }
    )
    expect(restored.outcome).toMatchObject({
      status: 'planned',
      applied: { status: 'applied', resumeOnOpen: 1 },
      plan: {
        blockers: [],
        summary: { entries: 3, autoWake: 0, byCapability: { 'exact-resume': 1 } }
      }
    })
    expect(restored.ptyIdsRightAfterApply).toEqual([])
    expect(restored.resumeHandles).toEqual([PROVIDER_SESSION_ID])

    const rows = await readRows(page2, worktreeId)
    expect(rows.map((row) => row.title)).toEqual(savedLabels)
    expect(rows.filter((row) => row.title === SHARED_LABEL)).toHaveLength(2)
    expect(new Set(rows.map((row) => row.id)).size).toBe(3)
    expect(rows.map((row) => row.leafId)).toEqual(created.map((row) => row.leafId))

    // W6. Until then this block measured the opposite: the active restored workspace mounted
    // every row, and cold restore consumed the handle. Now the rows stay without processes until
    // one is opened, and opening one starts exactly that one.
    const ids = rows.map((row) => row.id)
    expect(
      await page2.evaluate(
        ({ wt, tabIds }) => {
          const s = window.__store!.getState()
          return (s.tabsByWorktree[wt] ?? [])
            .filter((tab) => tabIds.includes(tab.id))
            .every((tab) => tab.dormancy?.reason === 'working-set-restore')
        },
        { wt: worktreeId, tabIds: ids }
      )
    ).toBe(true)
    await page2.evaluate((wt) => window.__store!.getState().setActiveWorktree(wt), worktreeId)
    await ensureTerminalVisible(page2)
    const placeholder = page2.getByTestId('dormant-terminal-placeholder')
    await expect(placeholder).toBeVisible({ timeout: 30_000 })

    // Programmatic selection of every row is composition, not an open.
    for (const id of ids) {
      await selectRow(page2, worktreeId, id)
    }
    await expectHeldFor(page2, worktreeId, ids, { live: [], baseline })
    expect(await resumeHandleCount(page2, worktreeId)).toBe(1)

    // Open the sealed agent row through the product surface.
    await selectRow(page2, worktreeId, ids[0])

    // W2: the continuity verdict must survive the trip into the product, on the one row that holds
    // a real resume handle. `none` is the tell that the derivation is dead code here — this row has
    // a sealed conversation, so it is either confirmed or unconfirmed, never "nothing to resume".
    // Which of the two depends on what this host can see today, and that is the point: the surface
    // reads the classifier rather than assuming. Asserted on the attribute, not the sentence, since
    // the sentence is translated and this suite runs under whatever locale the host has.
    const continuity = await page2
      .locator('[data-dormant-terminal-tab-id]')
      .first()
      .getAttribute('data-resume-continuity')
    expect(['exact', 'unconfirmed']).toContain(continuity)

    await page2.getByTestId('dormant-terminal-open').click()
    await expect
      .poll(() => liveRowIds(page2, worktreeId, ids), {
        timeout: 45_000,
        message: 'only the opened row acquired a process'
      })
      .toEqual([ids[0]])
    await expect
      .poll(() => resumeHandleCount(page2, worktreeId), {
        timeout: 45_000,
        message: 'the opened row consumed its own resume handle'
      })
      .toBe(0)
    await expectBoundInMain(page2, ids[0])
    await expectHeldFor(page2, worktreeId, ids, { live: [ids[0]], baseline })

    // Leaving the workspace and coming back re-runs activation; the siblings stay dormant.
    await page2.evaluate(() => window.__store!.getState().setActiveWorktree(null))
    await page2.evaluate((wt) => window.__store!.getState().setActiveWorktree(wt), worktreeId)
    await ensureTerminalVisible(page2)
    await selectRow(page2, worktreeId, ids[1])
    await expectHeldFor(page2, worktreeId, ids, { live: [ids[0]], baseline })

    // A second open adds exactly one more.
    await page2.getByTestId('dormant-terminal-open').click()
    await expect
      .poll(() => liveRowIds(page2, worktreeId, ids), {
        timeout: 45_000,
        message: 'the second opened row acquired a process'
      })
      .toEqual([ids[0], ids[1]])
    await expectBoundInMain(page2, ids[1])
    await expectHeldFor(page2, worktreeId, ids, { live: [ids[0], ids[1]], baseline })
    const after = await mainSessionIds(page2)
    console.log(
      `[w6-evidence] rows=${ids.length} mainSessionsBeforeRestore=${baseline.length} ` +
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
