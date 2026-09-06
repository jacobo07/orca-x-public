import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// A file explorer indents by depth. Nothing stops the indent from consuming the row, so past some
// depth the filename has no space left and the row shows an icon and nothing else. Directory names
// here are two characters so the only variable is the indent; the leaf name is long because a leaf
// that fits proves nothing about what happens when one does not.

const ROOT = 'hostile-depth-fixture'
const DEPTH = 14
const LEAF = 'a-deliberately-long-leaf-file-name.txt'
/** Narrowest explorer the store will hydrate to; below this it clamps back up. */
const NARROWEST_SIDEBAR_PX = 220
/** Room for an ellipsis and a glyph or two. Below this the name is decoration, not information. */
const MIN_READABLE_NAME_PX = 32

function segment(depth: number): string {
  return `d${String(depth).padStart(2, '0')}`
}

async function readWorktreePath(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const worktree = Object.values(state?.worktreesByRepo ?? {})
      .flat()
      .find((candidate) => candidate.id === worktreeId)
    if (!worktree) {
      throw new Error('active worktree path unavailable')
    }
    return worktree.path
  })
}

function rowByExactName(page: Page, name: string) {
  return page
    .locator('[data-file-explorer-row]')
    .filter({ has: page.locator(`[data-file-explorer-row-name]:text-is("${name}")`) })
}

/**
 * Walk the fixture open one directory at a time, returning how many actually expanded. The count is
 * the point: a walk that silently stopped at the first level would otherwise measure a shallow row
 * and report the same clean result as a walk that reached the bottom.
 */
async function expandFixture(page: Page): Promise<number> {
  await expect(rowByExactName(page, ROOT)).toBeVisible({ timeout: 15_000 })
  await rowByExactName(page, ROOT).click()

  let opened = 0
  for (let depth = 0; depth < DEPTH; depth += 1) {
    const row = rowByExactName(page, segment(depth))
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.click()
    opened += 1
  }
  return opened
}

test.describe('@file-explorer-geometry', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await openFileExplorer(orcaPage)
    await orcaPage.evaluate((width) => {
      window.__store?.getState().setRightSidebarWidth(width)
    }, NARROWEST_SIDEBAR_PX)
  })

  test('a deeply nested filename keeps room to be read', async ({ orcaPage }) => {
    const worktreePath = await readWorktreePath(orcaPage)
    const fixtureRoot = path.join(worktreePath, ROOT)
    const leafDir = path.join(
      fixtureRoot,
      ...Array.from({ length: DEPTH }, (_, depth) => segment(depth))
    )

    rmSync(fixtureRoot, { force: true, recursive: true })
    mkdirSync(leafDir, { recursive: true })
    writeFileSync(path.join(leafDir, LEAF), 'deep\n')

    try {
      const opened = await expandFixture(orcaPage)
      expect(opened).toBe(DEPTH)

      const leafRow = rowByExactName(orcaPage, LEAF)
      await expect(leafRow).toBeVisible({ timeout: 15_000 })

      const rowBox = await leafRow.boundingBox()
      const nameBox = await leafRow.locator('[data-file-explorer-row-name]').boundingBox()
      expect(rowBox).not.toBeNull()
      expect(nameBox).not.toBeNull()

      // The reported box does not shrink when an ancestor clips it, so width alone would call a
      // name readable while none of it is painted. Measure the part inside the row instead.
      const visibleWidth = Math.max(
        0,
        Math.min(nameBox!.x + nameBox!.width, rowBox!.x + rowBox!.width) - nameBox!.x
      )

      expect(visibleWidth).toBeGreaterThanOrEqual(MIN_READABLE_NAME_PX)
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true })
    }
  })

  test('a truncated filename can still be read in full', async ({ orcaPage }) => {
    const worktreePath = await readWorktreePath(orcaPage)
    const fixtureRoot = path.join(worktreePath, ROOT)

    rmSync(fixtureRoot, { force: true, recursive: true })
    mkdirSync(fixtureRoot, { recursive: true })
    writeFileSync(path.join(fixtureRoot, LEAF), 'long\n')

    try {
      const name = rowByExactName(orcaPage, ROOT)
      await expect(name).toBeVisible({ timeout: 15_000 })
      await name.click()

      const leafName = rowByExactName(orcaPage, LEAF).locator('[data-file-explorer-row-name]')
      await expect(leafName).toBeVisible({ timeout: 15_000 })

      // The session rail carries the full title on the row it truncates. Whatever the explorer uses
      // to do the same, the untruncated name has to be recoverable without opening the file.
      const accessibleFullName = await leafName.evaluate((element) => {
        const owned = element.closest('[data-file-explorer-row]')
        return (
          element.getAttribute('title') ??
          element.getAttribute('aria-label') ??
          owned?.getAttribute('title') ??
          owned?.getAttribute('aria-label') ??
          null
        )
      })

      expect(accessibleFullName).toBe(LEAF)
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true })
    }
  })
})
