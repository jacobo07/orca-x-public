/**
 * Product reality for W4: a working set saved through the real capture path is read back from disk
 * by a relaunched app and restored into its (emptied) workspace.
 *
 * What this proves: the manifest survives the creator's lifecycle; restore rebuilds the rail by
 * identity (two rows sharing a label stay two rows) in the sealed order; the apply step itself
 * starts no terminal; the one sealed provider session comes back only through the pane's own cold
 * restore, which consumes the lazy sleeping record.
 *
 * What it measures rather than asserts as a goal (the W6 boundary): the restored workspace is the
 * active one, so every restored row mounts and gets a process. That count is recorded; a later
 * wave inverts it.
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

    // W6 boundary, measured: the active restored workspace mounts every row, and the sealed
    // session's resume is issued by the pane's own cold restore, which consumes its handle.
    await expect
      .poll(
        () =>
          page2.evaluate((wt) => {
            const s = window.__store!.getState()
            return (s.tabsByWorktree[wt] ?? []).filter(
              (tab) => (s.ptyIdsByTabId[tab.id] ?? []).length > 0
            ).length
          }, worktreeId),
        { timeout: 45_000, message: 'restored rows that acquired a process' }
      )
      .toBe(3)
    await expect
      .poll(
        () =>
          page2.evaluate(
            (wt) =>
              Object.values(window.__store!.getState().sleepingAgentSessionsByPaneKey).filter(
                (record) => record.worktreeId === wt
              ).length,
            worktreeId
          ),
        { timeout: 45_000, message: 'the lazy resume handle was consumed by cold restore' }
      )
      .toBe(0)
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
