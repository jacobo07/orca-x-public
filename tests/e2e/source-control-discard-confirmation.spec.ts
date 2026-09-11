import { readFile, writeFile } from 'node:fs/promises'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { Locator, Page } from '@playwright/test'

type SeededUntrackedFile = {
  fileName: string
  /** Absolute, so a writer outside Electron can reach the same bytes the row is describing. */
  absolutePath: string
}

async function openSourceControl(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    state?.setRightSidebarOpen(true)
  })
  await page.getByRole('button', { name: /Source Control/ }).click()
  await page.getByTestId('source-control-filter-toggle').click()
  await expect(page.getByTestId('source-control-filter-input')).toBeVisible()
}

async function seedUntrackedFile(page: Page): Promise<SeededUntrackedFile> {
  return page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === worktreeId)
    if (!worktree) {
      throw new Error('active worktree not found')
    }

    const separator = worktree.path.includes('\\') ? '\\' : '/'
    const fileName = `orca-discard-confirm-${Date.now()}.txt`
    const relativePath = fileName
    await window.api.fs.writeFile({
      filePath: `${worktree.path}${separator}${relativePath}`,
      content: 'delete me\n'
    })

    // Why the identity flag: it is opt-in on status, and the Source Control refresh sets it for exactly
    // this reason -- a row painted without one is a row the discard refuses for a different reason. Seeding
    // without it would silently test the "could not tell" branch instead of the stale one.
    //
    // Why the poll: a write and the next status are two IPC round-trips with read caches between them, so a
    // single attempt can legitimately miss a file that exists. A bare "status did not include it" says
    // nothing about which of those it was, so the diagnostic carries what status actually returned.
    let statusEntry: { path: string; worktreeContentId?: string } | undefined
    let lastSeen: string[] = []
    for (let attempt = 0; attempt < 20 && !statusEntry; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      const status = await window.api.git.status({
        worktreePath: worktree.path,
        worktreeContentIdentity: true
      })
      state.setGitStatus(worktree.id, status)
      lastSeen = status.entries.map((entry) => entry.path)
      statusEntry = status.entries.find((entry) => entry.path.endsWith(fileName))
    }
    if (!statusEntry) {
      throw new Error(
        `git status never included ${fileName} in ${worktree.path}; it reported ${lastSeen.length} entries: ${lastSeen.join(', ')}`
      )
    }
    if (typeof statusEntry.worktreeContentId !== 'string' || statusEntry.worktreeContentId === '') {
      throw new Error(
        `the row for ${fileName} carries no observed content, so this fixture cannot authorize anything`
      )
    }

    return {
      fileName,
      absolutePath: `${worktree.path}${separator}${relativePath}`
    }
  })
}

async function refreshGitStatus(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      return
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === worktreeId)
    if (!worktree) {
      return
    }
    state.setGitStatus(worktree.id, await window.api.git.status({ worktreePath: worktree.path }))
  })
}

async function deleteUntrackedFileFromRow(row: Locator): Promise<void> {
  // Why a testid and not the accessible name: that name is translated, and this suite runs on hosts whose
  // Orca is not in English. Matching 'Delete untracked file' found nothing here -- and the sibling
  // assertion that the dialog had CLOSED passed vacuously for the same reason, which is the worse half.
  const deleteButton = row.getByTestId('source-control-entry-discard')
  // Why: row actions are hover/focus revealed; keyboard activation avoids
  // CI hover hit-test drift while exercising the same accessible control.
  await deleteButton.focus()
  await expect(deleteButton).toBeFocused()
  await deleteButton.press('Enter')
}

/** The dialog, by role alone: its title is translated, so naming it pins the test to one locale. */
function discardDialog(page: Page): Locator {
  return page.getByRole('dialog')
}

async function confirmPendingDelete(page: Page): Promise<void> {
  // By testid, because both other routes are wrong here: the label is translated, and the dialog's LAST
  // button is the content's close X, not the footer's action. Clicking either dismissed the dialog and left
  // the file exactly where a working refusal would have -- a false pass that only the toast assertion caught.
  const confirmButton = discardDialog(page).getByTestId('source-control-discard-confirm')
  await expect(confirmButton).toBeVisible()
  await confirmButton.click()
}

test.describe('Source Control discard confirmation', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('deletes an untracked file without confirmation', async ({ orcaPage }) => {
    const seededFile = await seedUntrackedFile(orcaPage)
    await openSourceControl(orcaPage)

    const row = orcaPage
      .locator('[data-testid="source-control-entry"]')
      .filter({ hasText: seededFile.fileName })
    await expect(row).toBeVisible()

    await deleteUntrackedFileFromRow(row)
    await confirmPendingDelete(orcaPage)

    await expect(
      discardDialog(orcaPage)
    ).toHaveCount(0)
    await expect(row).toHaveCount(0, { timeout: 10_000 })

    await refreshGitStatus(orcaPage)
    await expect(
      orcaPage.locator('[data-testid="source-control-entry"]').filter({
        hasText: seededFile.fileName
      })
    ).toHaveCount(0)
    // What makes the refusal notice in the next test mean anything: a discard that works says nothing at
    // all. Without this, "a notice appeared" would be compatible with a notice that always appears.
    await expect(orcaPage.locator('[data-sonner-toast]')).toHaveCount(0)
  })

  test('keeps a file an outside writer replaced while the confirmation was open', async ({
    orcaPage
  }) => {
    // The stale authorization, through the whole product for the first time. The confirmation dialog is a
    // human-time window by construction, so the race does not need manufacturing -- the user reviews state
    // A, something else writes B, and confirming must not destroy B.
    //
    // The competing writer is this Playwright process: a different OS process from Electron, honouring
    // none of the app's own serialization. That is the threat model, not a simulation of it.
    //
    // The test above is this one's control. Same fixture, same surface, nothing written -- and the file is
    // destroyed. Without it, "the file is still there" would also be what a confirm that never reached the
    // host looks like.
    const seededFile = await seedUntrackedFile(orcaPage)
    await openSourceControl(orcaPage)

    const row = orcaPage
      .locator('[data-testid="source-control-entry"]')
      .filter({ hasText: seededFile.fileName })
    await expect(row).toBeVisible()

    await deleteUntrackedFileFromRow(row)
    await expect(
      discardDialog(orcaPage)
    ).toBeVisible()

    const bytesWrittenOutside = 'work that arrived while the dialog was open\n'
    await writeFile(seededFile.absolutePath, bytesWrittenOutside, 'utf8')

    await confirmPendingDelete(orcaPage)

    // The user is told, and not with an error: a discard that succeeds raises no toast at all, and a real
    // failure raises `toast.error`. So a non-error notice here is the refusal reaching the user. Which
    // sentence of the three it is belongs to discard-refusal-message's own tests, not to a locale-
    // dependent string match in Electron.
    const notice = orcaPage.locator('[data-sonner-toast]').first()
    await expect(notice).toBeVisible({ timeout: 15_000 })
    await expect(notice).not.toHaveAttribute('data-type', 'error')
    await expect(notice).not.toBeEmpty()

    // The authoritative evidence: the bytes on disk, read outside the app.
    expect(await readFile(seededFile.absolutePath, 'utf8')).toBe(bytesWrittenOutside)
    // And nothing claimed the row was gone.
    await expect(row).toBeVisible()
  })
})
