/**
 * The binding a window holds must name the worktree that window is showing.
 *
 * A worktree binds to at most one window (`src/main/window/workspace-window-registry.ts`), and that
 * rule is only as good as the record behind it. If a window stops tracking what it shows, the
 * registry describes a window that no longer exists as described: the worktree on screen reads as
 * free, a second window may claim it, and both end up resolving one terminal tab and one PTY.
 *
 * This ran red for one commit. Switching worktrees inside a window claimed nothing: the binding
 * stayed on whatever was claimed last, so the project on screen read as unowned and — with a second
 * window open — session writes stayed scoped to the project the user had left, since main derives
 * that scope from the binding. The claim now happens in `setActiveWorktree`, the single writer to
 * the active workspace, so every navigation surface reaches it rather than each one remembering.
 *
 * `getStartupBinding` answers from the window's own record, which makes the binding readable with one
 * call and one window. The claim below stands in for the launcher: the packaged profile is seeded
 * with onboarding only, so there is no saved session to restore and nothing else here would give the
 * window a binding to drift from.
 */

import { existsSync, readFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  launchPackagedOrca,
  PACKAGED_ORCA_APP_DIR,
  resolvePackagedOrcaExecutable,
  type PackagedOrcaRun
} from './helpers/packaged-orca-app'
import { getStoreState, waitForActiveWorktree } from './helpers/store'

test(
  'a packaged window updates its binding when it switches worktree @headful',
  async (
    // oxlint-disable-next-line no-empty-pattern -- this spec owns its own launch and opts out of the app fixture.
    {},
    testInfo
  ) => {
    const executablePath = resolvePackagedOrcaExecutable()
    test.skip(
      executablePath === null,
      `no packaged Windows artifact at ${PACKAGED_ORCA_APP_DIR} — build it before this gate can say anything`
    )
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    test.skip(!repoPath || !existsSync(repoPath), 'global setup did not produce a seeded test repo')

    test.setTimeout(300_000)

    let run: PackagedOrcaRun | null = null
    try {
      run = await launchPackagedOrca({
        executablePath: executablePath as string,
        repoPath,
        testInfo
      })
      const { page } = run

      const firstWorktreeId = await waitForActiveWorktree(page)
      const repoId = await page.evaluate((worktreeId) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        const state = store.getState()
        for (const [candidate, worktrees] of Object.entries(state.worktreesByRepo)) {
          if ((worktrees ?? []).some((worktree) => worktree.id === worktreeId)) {
            return candidate
          }
        }
        return state.activeRepoId ?? null
      }, firstWorktreeId)
      expect(repoId, 'no repository to branch a second worktree from — setup failure').toBeTruthy()

      // Asked, not established: the window has been showing this project since launch, and entering
      // one is what claims it. `already-owned` is therefore the proof that the automatic claim ran —
      // `claimed` here would mean the window was presenting a project the registry thought was free.
      const claimed = await page.evaluate(
        async ({ owningRepoId, worktreeId }) =>
          (await window.api.ui.claimWorkspace({ repoId: owningRepoId, worktreeId })).outcome,
        { owningRepoId: repoId as string, worktreeId: firstWorktreeId }
      )
      console.error(`[binding] claim for the project already on screen=${claimed}`)
      expect(
        claimed,
        'the window was showing a project it had not claimed, so the registry reported it as free and a second window could have taken it'
      ).toBe('already-owned')

      // The ordinary in-window move: a second worktree, selected the way a sidebar row selects one.
      const secondWorktreeId = await page.evaluate(async (owningRepoId) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        const created = await store
          .getState()
          .createWorktree(owningRepoId, `e2e-binding-switch-${Date.now()}`)
        await store.getState().fetchWorktrees(owningRepoId)
        store.getState().setActiveWorktree(created.worktree.id)
        return created.worktree.id
      }, repoId as string)

      await expect
        .poll(async () => page.evaluate(() => window.__store?.getState().activeWorktreeId ?? null), {
          timeout: 60_000,
          message: 'the window never switched to the second worktree — setup failure'
        })
        .toBe(secondWorktreeId)

      // Polled rather than read once: the switch is synchronous but the claim behind it is a round
      // trip to main, so a single read samples whichever side of it happened to land first. A window
      // that never claims stays wrong for any timeout, so waiting costs no strictness.
      await expect
        .poll(
          async () => (await page.evaluate(() => window.api.ui.getStartupBinding())).worktreeId,
          {
            timeout: 30_000,
            message:
              'the window switched worktree without claiming it: the registry still names the previous project, so the one on screen reads as free and a second window may claim it'
          }
        )
        .toBe(secondWorktreeId)
      console.error(`[binding] showing and bound to ${secondWorktreeId} (was ${firstWorktreeId})`)

      // The other half of the switch: the project the window left has to become claimable, or the
      // stale binding has only changed direction. A second window is the only honest way to ask —
      // this window rebinding to it would prove nothing, since a window may always take what it
      // already holds.
      const pageB = await Promise.all([
        run.app.waitForEvent('window', { timeout: 60_000 }),
        page.evaluate(() => window.api.ui.createWindow())
      ]).then(([opened]) => opened)
      await pageB.waitForLoadState('domcontentloaded')
      await expect
        .poll(async () => getStoreState<boolean>(pageB, 'persistedUIReady'), {
          timeout: 60_000,
          message: 'the second packaged window never finished hydrating — setup failure'
        })
        .toBe(true)

      const releasedClaim = await pageB.evaluate(
        async ({ owningRepoId, worktreeId }) =>
          (await window.api.ui.claimWorkspace({ repoId: owningRepoId, worktreeId })).outcome,
        { owningRepoId: repoId as string, worktreeId: firstWorktreeId }
      )
      expect(
        releasedClaim,
        'the first window kept its old project after switching away, so nothing else can ever open it'
      ).toBe('claimed')

      // And the refusal: the first window asks for the project the second one now owns. The claim
      // handler reveals the owner itself, so all that is left to check is that this window did not
      // settle on a project it does not own.
      await page.evaluate((worktreeId) => {
        window.__store?.getState().setActiveWorktree(worktreeId)
      }, firstWorktreeId)
      await expect
        .poll(async () => page.evaluate(() => window.__store?.getState().activeWorktreeId ?? null), {
          timeout: 30_000,
          message:
            'the first window stayed on a project another window owns, so both now present it as theirs'
        })
        .toBe(secondWorktreeId)

      const bindingB = await pageB.evaluate(() => window.api.ui.getStartupBinding())
      expect(
        bindingB.worktreeId,
        "the refused switch took the project away from the window that owns it"
      ).toBe(firstWorktreeId)
      const bindingAAfterRefusal = await page.evaluate(() => window.api.ui.getStartupBinding())
      console.error(
        `[binding] after refusal: A bound=${bindingAAfterRefusal.worktreeId ?? 'none'} B bound=${bindingB.worktreeId ?? 'none'}`
      )
      expect(
        bindingAAfterRefusal.worktreeId,
        'the first window lost its own project by asking for one it could not have'
      ).toBe(secondWorktreeId)
    } finally {
      await run?.dispose()
    }
  }
)
