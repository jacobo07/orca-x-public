/**
 * R3 density lab, logical dimension — Product Reality at scale.
 *
 * `project-working-set-restore.spec.ts` already proves this shape at three rows. Three rows cannot
 * fail it in an interesting way: a title-keyed, index-keyed or wake-everything bug is invisible when
 * the rail is small enough to get right by accident. This runs the same claim at fifty rows that all
 * share one label, so identity can only be resolved by tab id.
 *
 * The seed is not authored. Two rows are captured live through the real producer, and
 * `cloneWorkingSetToScale` multiplies that captured shape to fifty, regenerating only the identities
 * that must be unique. The manifest is then written into the store as a sibling artifact, so the
 * app reads it back through its own sealed reader.
 *
 * Every figure here is a COUNT — rows, sessions, dormancy reasons. Counts are load-independent, so
 * this is valid on a busy host. The byte curve (Dormant Session Tax, Marginal Idle Session Cost) and
 * cold-revival latency are NOT here: both need the lab's host-headroom floor.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { cloneWorkingSetToScale } from '../../src/shared/project-working-set-scale-clone'
import { readProjectWorkingSetManifest } from '../../src/shared/project-working-set-schema'
import { waitForActiveTerminalManager, waitForPaneCount } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { worktreeRowSurface } from './worktree-row-locators'

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __workingSetE2E?: {
      save: (request: { ownerKey: string; label?: string | null }) => Promise<unknown>
      list: (scope: { executionHostId: 'local'; ownerKey: string }) => Promise<unknown>
      restore: (request: {
        scope: { executionHostId: 'local'; ownerKey: string }
        workingSetId: string
      }) => Promise<unknown>
    }
  }
}

const ROWS = 50
/** Every cloned row carries this, so a title can never identify one. */
const SHARED_LABEL = 'Build'
const PROVIDER_SESSION_ID = 'e2e-dormant-density-session'
/** Mid-rail, so an off-by-one or first/last heuristic cannot land on it by luck. */
const TARGET_INDEX = 25

function findArtifact(root: string, workingSetId: string): string {
  const wanted = `${workingSetId}.json`
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        stack.push(full)
      } else if (name === wanted) {
        return full
      }
    }
  }
  throw new Error(`no working-set artifact named ${wanted} under ${root}`)
}

async function railIds(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate((wt) => {
    const s = window.__store!.getState()
    const order = (s.groupsByWorktree[wt] ?? []).flatMap((group) => group.tabOrder)
    const present = new Set((s.tabsByWorktree[wt] ?? []).map((tab) => tab.id))
    return order.filter((id) => present.has(id))
  }, worktreeId)
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

async function emptyWorkspace(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((wt) => {
    const s = window.__store!.getState()
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
      { timeout: 20_000, message: 'workspace did not empty' }
    )
    .toBe(0)
}

/**
 * An absence is only evidence over a window, and only by identity: a count lets two new PTYs hide
 * behind two that are still exiting. Every sample must show exactly `live` rows with a process, and
 * every main session absent from `baseline` must belong to one of them.
 */
async function expectHeldFor(
  page: Page,
  worktreeId: string,
  ids: string[],
  expected: { live: string[]; baseline: string[] }
): Promise<void> {
  const violations: string[] = []
  for (let sample = 0; sample < 12; sample++) {
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

/**
 * A baseline read the instant the store empties is not a baseline: main registers and unregisters
 * PTYs on its own schedule, so a session from the source phase can surface AFTER the read and then
 * be indistinguishable from one the restore started. Waits for the host's own list to stop moving,
 * then snapshots. Anything the subject creates appears strictly later and cannot hide in here.
 */
async function quiescedBaseline(page: Page): Promise<string[]> {
  let previous = await mainSessionIds(page)
  let stable = 0
  for (let attempt = 0; attempt < 40 && stable < 3; attempt++) {
    await page.waitForTimeout(250)
    const current = await mainSessionIds(page)
    stable = JSON.stringify(current) === JSON.stringify(previous) ? stable + 1 : 0
    previous = current
  }
  // A list that never settles makes every later absence claim unfalsifiable; fail loudly instead.
  expect(stable, 'main session list never quiesced before the baseline').toBeGreaterThanOrEqual(3)
  return previous
}

test.describe.configure({ mode: 'serial' })

test('fifty remembered rows stay dormant, and one open wakes exactly its own row', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }

  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null

  try {
    const launched = await session.launch()
    app = launched.app
    const page = await app.firstWindow()
    const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)
    await page.evaluate(() =>
      window.__store!.getState().updateSettings({ agentCmdOverrides: { codex: 'echo' } })
    )

    // Two REAL rows: the producer defines the shape, the clone only multiplies it.
    await page.evaluate((wt) => window.__store!.getState().createTab(wt), worktreeId)
    await expect
      .poll(async () => (await railIds(page, worktreeId)).length, {
        timeout: 30_000,
        message: 'two mounted terminals'
      })
      .toBe(2)
    const sourceIds = await railIds(page, worktreeId)
    const sourceLeafIds = await page.evaluate((ids) => {
      const s = window.__store!.getState()
      return ids.map((id) => {
        const root = s.terminalLayoutsByTabId[id]?.root
        return root?.type === 'leaf' ? root.leafId : null
      })
    }, sourceIds)
    await page.evaluate(
      ({ ids, label }) => {
        const s = window.__store!.getState()
        for (const id of ids) {
          s.setTabCustomTitle(id, label)
        }
      },
      { ids: sourceIds, label: SHARED_LABEL }
    )

    // Hermetic stand-in for an agent's hook report: the same store entry a real run writes.
    const transcriptPath = session.seedCodexResumeRollout(PROVIDER_SESSION_ID, repoPath)
    await page.evaluate(
      ({ paneKey, wt, id, path }) => {
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
        paneKey: `${sourceIds[0]}:${sourceLeafIds[0]}`,
        wt: worktreeId,
        id: PROVIDER_SESSION_ID,
        path: transcriptPath
      }
    )

    const saved = await page.evaluate(
      (wt) => window.__workingSetE2E!.save({ ownerKey: wt, label: 'density-source' }),
      worktreeId
    )
    expect(saved).toMatchObject({ status: 'saved' })
    const sourceWorkingSetId = (saved as { workingSetId: string }).workingSetId

    // Scale the captured artifact on disk, beside the one the product wrote.
    const artifactPath = findArtifact(session.userDataDir, sourceWorkingSetId)
    const sourceOutcome = readProjectWorkingSetManifest(
      JSON.parse(readFileSync(artifactPath, 'utf-8'))
    )
    expect(sourceOutcome.status).toBe('valid')
    if (sourceOutcome.status !== 'valid') {
      return
    }
    const scaledId = globalThis.crypto.randomUUID()
    const scaled = cloneWorkingSetToScale(sourceOutcome.manifest, ROWS, {
      newId: () => globalThis.crypto.randomUUID(),
      workingSetId: scaledId
    })
    writeFileSync(
      join(artifactPath, '..', `${scaledId}.json`),
      JSON.stringify(scaled, null, 2),
      'utf-8'
    )

    await emptyWorkspace(page, worktreeId)
    // Taken before the restore, so nothing it starts can hide inside the baseline.
    const baseline = await quiescedBaseline(page)

    const scope = { executionHostId: 'local' as const, ownerKey: worktreeId }
    const history = await page.evaluate((s) => window.__workingSetE2E!.list(s), scope)
    expect(
      (history as { valid: { workingSetId: string }[] }).valid.map((m) => m.workingSetId)
    ).toContain(scaledId)

    const restored = await page.evaluate(
      async ({ s, id }) => {
        const outcome = await window.__workingSetE2E!.restore({ scope: s, workingSetId: id })
        // Read in the same turn as the apply: nothing has rendered yet.
        const state = window.__store!.getState()
        const tabs = state.tabsByWorktree[s.ownerKey] ?? []
        return {
          outcome,
          ptyIdsRightAfterApply: tabs.flatMap((t) => state.ptyIdsByTabId[t.id] ?? [])
        }
      },
      { s: scope, id: scaledId }
    )
    expect(restored.outcome).toMatchObject({
      status: 'planned',
      applied: { status: 'applied' },
      plan: { blockers: [], summary: { entries: ROWS, autoWake: 0 } }
    })
    expect(restored.ptyIdsRightAfterApply).toEqual([])

    const ids = await railIds(page, worktreeId)
    expect(ids).toHaveLength(ROWS)
    expect(new Set(ids).size).toBe(ROWS)
    // Identity is the only discriminator left: every row shows the same title.
    const titles = await page.evaluate(
      ({ wt, tabIds }) => {
        const s = window.__store!.getState()
        const byId = new Map((s.tabsByWorktree[wt] ?? []).map((t) => [t.id, t]))
        return tabIds.map((id) => byId.get(id)?.customTitle ?? byId.get(id)?.title ?? null)
      },
      { wt: worktreeId, tabIds: ids }
    )
    expect(new Set(titles)).toEqual(new Set([SHARED_LABEL]))
    await page.evaluate((wt) => window.__store!.getState().setActiveWorktree(wt), worktreeId)
    await ensureTerminalVisible(page)
    // Processes first, chrome second. Activation is where a non-dormant row would mount and spawn,
    // so the absence of PTYs is judged before anything about the placeholder that reports dormancy:
    // a missing placeholder is a symptom, a running shell is the defect.
    await expectHeldFor(page, worktreeId, ids, { live: [], baseline })
    await expect(page.getByTestId('dormant-terminal-placeholder')).toBeVisible({ timeout: 30_000 })

    // Activating every one of the fifty is composition, not an open.
    await page.evaluate(
      ({ wt, tabIds }) => {
        const s = window.__store!.getState()
        for (const id of tabIds) {
          s.activateTab(id, { worktreeId: wt })
          s.setActiveTab(id)
        }
      },
      { wt: worktreeId, tabIds: ids }
    )
    await expectHeldFor(page, worktreeId, ids, { live: [], baseline })

    expect(
      await page.evaluate(
        ({ wt, tabIds }) => {
          const s = window.__store!.getState()
          return (s.tabsByWorktree[wt] ?? [])
            .filter((t) => tabIds.includes(t.id))
            .every((t) => t.dormancy?.reason === 'working-set-restore')
        },
        { wt: worktreeId, tabIds: ids }
      )
    ).toBe(true)

    // Open exactly one, mid-rail, through the product surface.
    const target = ids[TARGET_INDEX]
    await page.evaluate(
      ({ wt, id }) => {
        const s = window.__store!.getState()
        s.activateTab(id, { worktreeId: wt })
        s.setActiveTab(id)
      },
      { wt: worktreeId, id: target }
    )
    await expect(page.getByTestId('dormant-terminal-placeholder')).toHaveAttribute(
      'data-dormant-terminal-tab-id',
      target,
      { timeout: 20_000 }
    )
    await page.getByTestId('dormant-terminal-open').click()
    await expect
      .poll(() => liveRowIds(page, worktreeId, ids), {
        timeout: 60_000,
        message: 'exactly the opened row acquired a process'
      })
      .toEqual([target])
    await expectHeldFor(page, worktreeId, ids, { live: [target], baseline })

    const liveBeforeReclaim = await page.evaluate(
      ({ id }) => window.__store!.getState().ptyIdsByTabId[id] ?? [],
      { id: target }
    )
    expect(liveBeforeReclaim.length).toBeGreaterThan(0)
    // The peak, recorded before the reclaim removes it again: a line printed only after the reclaim
    // reads the same whether one row woke or nothing ever happened.
    const peakNewSessions = (await mainSessionIds(page)).filter((id) => !baseline.includes(id))
    expect(peakNewSessions).toHaveLength(1)

    // Reclaim through the canonical surface: workspace Sleep releases the runtime and keeps the row.
    // Docked left, the side panel and the workspace list are alternatives.
    await page.evaluate(() => {
      const s = window.__store!.getState()
      s.setRightSidebarOpen(false)
      s.setSidebarOpen(true)
    })
    await expect(worktreeRowSurface(page, worktreeId)).toBeVisible({ timeout: 30_000 })
    await worktreeRowSurface(page, worktreeId).click({ button: 'right' })
    await page.getByTestId('worktree-menu-sleep').click()
    await expect
      .poll(() => liveRowIds(page, worktreeId, ids), {
        timeout: 60_000,
        message: 'sleep released the running row'
      })
      .toEqual([])
    await expect
      .poll(
        async () => (await mainSessionIds(page)).filter((id) => liveBeforeReclaim.includes(id)),
        {
          timeout: 60_000,
          message: 'main still lists the slept PTY'
        }
      )
      .toEqual([])

    // Structural reclaim: the runtime is gone and the logical working set is entirely intact.
    const afterReclaim = await railIds(page, worktreeId)
    expect(afterReclaim).toEqual(ids)
    expect(
      await page.evaluate(
        ({ wt, tabIds }) => {
          const s = window.__store!.getState()
          return (s.tabsByWorktree[wt] ?? [])
            .filter((t) => tabIds.includes(t.id))
            .every((t) => Boolean(t.dormancy))
        },
        { wt: worktreeId, tabIds: ids }
      )
    ).toBe(true)

    const after = await mainSessionIds(page)
    console.log(
      `[r3-logical-density] rows=${ids.length} ` +
        `mainSessionsBeforeRestore=${baseline.length} ` +
        `newMainSessionsAfterRestore=0 ` +
        `newMainSessionsAtPeak=${peakNewSessions.length} ` +
        `newMainSessionsAfterReclaim=${after.filter((id) => !baseline.includes(id)).length} ` +
        `liveRowsAfterReclaim=${(await liveRowIds(page, worktreeId, ids)).length} ` +
        `rowsSurvivingReclaim=${afterReclaim.length}`
    )
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
})
