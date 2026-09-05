/**
 * A window bound to a project names that project, in the title the OS actually shows.
 *
 * This lives in E2E rather than a unit test because the load-bearing claim is not the string
 * derivation (that is covered by src/shared/window-identity-title.test.ts) — it is that writing
 * document.title in the renderer reaches BrowserWindow.getTitle(), which is what Alt-Tab, the
 * taskbar and the task switcher read. Only a real Electron launch can show that, and it is exactly
 * the direction the fork previously got wrong: the packaged identity said "Orca X" while every
 * window said "Orca", because index.html's <title> silently outranked the BrowserWindow option.
 *
 * Locale-independent by construction: the expected project name is read from the store rather than
 * asserted as English text.
 */

import { test, expect } from './helpers/orca-app'
import { getStoreState } from './helpers/store'
import { PRODUCT_NAME } from '../../src/shared/product'

type StoreRepo = { id: string; displayName: string }

test('names the window after the bound project, not the product', async ({
  electronApp,
  sharedPage
}) => {
  test.setTimeout(180_000)

  // Arrange — the shared fixture has already attached the seeded repo and activated a worktree.
  // Polled: binding settles asynchronously after the session reports ready.
  // Resolve the owning repo through the ACTIVE WORKTREE, deliberately not through `activeRepoId`.
  // Measured: a bound window can leave `activeRepoId` null while a worktree is active, so keying an
  // expectation off it would make this gate agree with a bug. Worktree ids are `${repoId}::${path}`
  // (src/shared/worktree/types.ts:61), which gives the test an instrument independent of the hook.
  const snapshot = async (): Promise<{
    activeWorktreeId: string | null
    repoIds: string[]
    projectName: string
  }> => {
    const activeWorktreeId = await getStoreState<string | null>(sharedPage, 'activeWorktreeId')
    const repos = await getStoreState<StoreRepo[]>(sharedPage, 'repos')
    const owningRepoId = activeWorktreeId?.split('::')[0] ?? null
    return {
      activeWorktreeId,
      repoIds: repos.map((repo) => repo.id),
      projectName: repos.find((repo) => repo.id === owningRepoId)?.displayName ?? ''
    }
  }

  // Record the evidence BEFORE any assertion can throw, so a failure explains itself.
  console.log(`[window-identity] initial: ${JSON.stringify(await snapshot())}`)

  await expect.poll(async () => (await snapshot()).projectName, { timeout: 60_000 }).not.toBe('')
  const bound = await snapshot()
  console.log(`[window-identity] bound state: ${JSON.stringify(bound)}`)
  const projectName = bound.projectName

  // Act — read the title the operating system sees, not the one the renderer believes it set.
  const readNativeTitle = async (): Promise<string | null> =>
    electronApp.evaluate(({ BrowserWindow }) => {
      const [firstWindow] = BrowserWindow.getAllWindows()
      return firstWindow ? firstWindow.getTitle() : null
    })

  // The bare product name is precisely what a regression here would leave behind, so waiting for
  // it to go away is a gate whose red branch is reachable.
  await expect.poll(readNativeTitle, { timeout: 30_000 }).not.toBe(PRODUCT_NAME)
  const nativeTitle = await readNativeTitle()

  // Assert — the project leads so two windows are distinguishable, and the brand still trails.
  expect(nativeTitle).toContain(projectName)
  expect(nativeTitle).toContain(PRODUCT_NAME)
  expect(nativeTitle?.indexOf(projectName)).toBeLessThan(nativeTitle?.indexOf(PRODUCT_NAME) ?? -1)

  // And the renderer's own document title agrees with what the OS is showing.
  expect(await sharedPage.title()).toBe(nativeTitle)
})
