/**
 * Establishes the seeded project + worktrees every non-golden E2E spec starts from.
 *
 * Why this is its own module: none of it is behaviour under test. It is the precondition, and
 * keeping it separate from the fixture that consumes it makes the boundary between "we could not
 * set the test up" and "the product misbehaved" a file boundary rather than a comment.
 *
 * Each step runs inside a named phase so a failure carries where setup stopped. See
 * e2e-precondition.ts for the classification that depends on those marks.
 */

import { expect as playwrightExpect, type Page, type TestInfo } from '@stablyai/playwright-test'
import { createSeededTestRepo, isValidGitRepo } from './seeded-test-repo'
import { recordPreconditionAttempts, runSetupPhase } from './e2e-precondition'

export async function establishSeededWorkspace({
  page,
  testRepoPath,
  testInfo
}: {
  page: Page
  testRepoPath: string
  testInfo?: TestInfo
}): Promise<void> {
  const repoPath = isValidGitRepo(testRepoPath) ? testRepoPath : createSeededTestRepo()

  // Add the test repo via the IPC bridge
  // Why: calling window.api.repos.add() goes through the same code path as
  // the "Add Project" UI flow, ensuring worktrees are fetched and the session
  // initializes properly.
  const seededRepoId = await runSetupPhase(
    'repository-seed',
    () =>
      page.evaluate(async (repoPath) => {
        const result = await window.api.repos.add({ path: repoPath })
        if ('error' in result) {
          throw new Error(result.error)
        }
        return result.repo.id
      }, repoPath),
    testInfo
  )

  // Fetch repos in the renderer store so it picks up the new repo, then opt
  // this disposable repo into showing external worktrees.
  // Why: repos.add() fires a repos:changed echo that triggers a *concurrent*
  // fetchRepos() in the renderer; the store's generation guard can then drop
  // this awaited fetch's result, leaving `repos` briefly stale. Poll the
  // public fetch path until the repo lands instead of asserting on the first
  // tick (mirrors the seeded-worktree poll below). updateRepo is idempotent,
  // so running it once the repo appears is safe across poll ticks.
  await runSetupPhase(
    'repository-seed',
    async () => {
      await playwrightExpect
        .poll(
          () =>
            page.evaluate(async (repoId) => {
              const store = window.__store
              if (!store) {
                return false
              }
              await store.getState().fetchRepos()
              const repo = store.getState().repos.find((candidate) => candidate.id === repoId)
              if (!repo) {
                return false
              }
              // Why: the fixture deliberately creates external Git worktrees. New
              // repos hide those by default after the visibility rollout.
              await store.getState().updateRepo(repo.id, { externalWorktreeVisibility: 'show' })
              return true
            }, seededRepoId),
          {
            timeout: 30_000,
            message: `Expected e2e repo to be loaded: ${repoPath}`
          }
        )
        .toBe(true)
    },
    testInfo
  )

  // Best-effort fetch of the seeded repo's worktrees. Why: the renderer can still
  // re-navigate during initial hydration and destroy the execution context
  // mid-evaluate; the authoritative seeded-worktree poll below is the real wait,
  // so swallow a hydration-reload failure here instead of failing setup.
  await page
    .evaluate(async (repoId) => {
      const store = window.__store
      if (!store) {
        return
      }
      await store.getState().fetchWorktrees(repoId)
    }, seededRepoId)
    .catch(() => false)

  // Why: parallel specs mutate real git worktrees in the shared fixture repo.
  // A first scan can briefly return no rows while git holds a worktree lock,
  // so poll the public fetch path until the seeded primary + secondary load.
  let worktreeSeedAttempts = 0
  await runSetupPhase(
    'worktree-seed',
    async () => {
      await playwrightExpect
        .poll(
          () => {
            // Why: a run that settled on the eleventh attempt and one that settled on the first
            // are both green, and only one of them is healthy. The count is this flake's only
            // visible symptom on a passing run.
            worktreeSeedAttempts += 1
            return page.evaluate(async (repoId) => {
              const store = window.__store
              if (!store) {
                return 0
              }
              await store.getState().fetchWorktrees(repoId)
              return store.getState().worktreesByRepo[repoId]?.length ?? 0
            }, seededRepoId)
          },
          {
            timeout: 30_000,
            message: 'seeded e2e worktrees did not load'
          }
        )
        .toBeGreaterThanOrEqual(2)
    },
    testInfo
  )
  recordPreconditionAttempts('worktree-seed', worktreeSeedAttempts, testInfo)

  // Wait for workspaceSessionReady to become true
  await runSetupPhase(
    'session-ready',
    () =>
      page.waitForFunction(
        () => {
          const store = window.__store
          return store?.getState().workspaceSessionReady === true
        },
        null,
        { timeout: 30_000 }
      ),
    testInfo
  )

  // Re-activate the test repo's primary worktree after session hydration.
  // Why: workspaceSessionReady restoration can overwrite activeWorktreeId
  // after earlier setup calls. Selecting it here ensures every test starts on
  // the seeded repo instead of the "Select a worktree" empty state.
  await runSetupPhase(
    'workspace-activation',
    () =>
      page.evaluate((repoId: string) => {
        const store = window.__store
        if (!store) {
          return
        }

        const state = store.getState()
        // Why: provider-returned identity is stable across Windows path casing
        // and separator normalization, unlike comparing renderer path strings.
        const testWorktree = state.worktreesByRepo[repoId]?.find(
          (worktree) => worktree.isMainWorktree
        )
        if (testWorktree) {
          state.setActiveWorktree(testWorktree.id)
        }
      }, seededRepoId),
    testInfo
  )

  // Best-effort seed of a baseline terminal tab when a fresh isolated
  // profile has none yet.
  // Why: terminal-focused suites call ensureTerminalVisible(), which does the
  // authoritative wait. The shared fixture itself should not block non-
  // terminal suites on tab creation timing.
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      return
    }
    const state = store.getState()
    if (!state.activeWorktreeId) {
      return
    }
    const tabs = state.tabsByWorktree[state.activeWorktreeId] ?? []
    if (tabs.length === 0) {
      state.createTab(state.activeWorktreeId)
    }
  })
}
