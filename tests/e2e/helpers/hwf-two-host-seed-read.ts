import { expect, type Page } from '@stablyai/playwright-test'

import type { HwfRun } from './hwf-two-host-ssh-target'

// Renderer session writer debounces 150 ms (session-write-subscriber.ts) and main's store save debounces 1000 ms.
const PERSISTENCE_FLUSH_WAIT_MS = 2_500

/**
 * Makes Client A hold the host-only seed content, so a later absence scan can fail.
 * Reads through the product fs API, then opens the file in the real editor and closes it, then
 * waits out the persistence debounces.
 */
export async function readSeedThroughClientA(
  page: Page,
  run: HwfRun,
  connectionId: string,
  worktreeId: string
): Promise<number> {
  const seedPath = `${run.repo}/seed.txt`
  const read = await page.evaluate(
    ({ filePath, connectionId }) => window.api.fs.readFile({ filePath, connectionId }),
    { filePath: seedPath, connectionId }
  )
  expect(read.isBinary).toBe(false)
  expect(read.content).toContain(run.seedNonce)
  const bytes = Buffer.byteLength(read.content)

  const fileId = await page.evaluate(
    ({ filePath, worktreeId }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Store unavailable')
      }
      if (state.activeWorktreeId !== worktreeId) {
        state.setActiveWorktree(worktreeId)
      }
      state.openFile({
        filePath,
        relativePath: 'seed.txt',
        worktreeId,
        language: 'plaintext',
        mode: 'edit'
      })
      const file = window.__store
        ?.getState()
        .openFiles.find((f) => f.filePath === filePath && f.worktreeId === worktreeId)
      if (!file) {
        throw new Error(`editor did not open ${filePath}`)
      }
      state.setActiveFile(file.id)
      state.setActiveTabType('editor')
      return file.id
    },
    { filePath: seedPath, worktreeId }
  )
  await expect(page.locator('.editor-header-path').first()).toContainText('seed.txt', {
    timeout: 30_000
  })
  // Let the editor load the content before closing; a closed-too-early tab would cache nothing.
  await page.waitForTimeout(1_500)
  await page.evaluate((id) => {
    const state = window.__store?.getState()
    state?.closeFile(id)
    state?.setActiveTabType('terminal')
  }, fileId)
  await expect(page.locator('.editor-header-path').filter({ hasText: 'seed.txt' })).toHaveCount(0)
  await page.waitForTimeout(PERSISTENCE_FLUSH_WAIT_MS)
  console.log(`HWF_SEED_READ=ok bytes=${bytes} editor=opened-and-closed flush_wait_ms=${PERSISTENCE_FLUSH_WAIT_MS}`)
  return bytes
}
