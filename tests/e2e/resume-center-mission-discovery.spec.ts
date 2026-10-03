import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal } from './helpers/orca-restart'

/**
 * Mission Brief is found from the list, before anyone knows where to click.
 *
 * Hermetic: two throwaway repos, one holding a .planning/STATE.md and one holding nothing. No GSD
 * and no MISSION_BRIEF_REPOS, so it runs on every host — the chip comes from the brief's own
 * no-mission gate, which needs only the disk. What the brief then says without GSD is the honest
 * "GSD absent", and a repo with no records says "no mission": neither invents a frontier.
 */

test.setTimeout(300_000)

function makeRepo(name: string, withMission: boolean): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `orca-e2e-mission-${name}-`))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  git('init', '-q')
  git('config', 'user.email', 'e2e@orca.test')
  git('config', 'user.name', 'orca e2e')
  writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`)
  if (withMission) {
    mkdirSync(path.join(dir, '.planning'))
    writeFileSync(
      path.join(dir, '.planning', 'STATE.md'),
      '# State\n\n## Current Position\n\nPhase: 1\n'
    )
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'seed')
  return dir
}

async function openResumeCenter(page: Page): Promise<void> {
  await page.locator('[data-workspace-activity="agent-workspace"]').first().click()
  await page.locator('[data-workspace-nav-item="resume"]').click()
  await expect(page.getByTestId('resume-center-page')).toBeVisible({ timeout: 15_000 })
}

test.describe('@resume-center-mission-discovery', () => {
  test('a row with mission records says so before any selection, and opens its own brief', async ({
    orcaPage
  }) => {
    // Why three: the page auto-selects the most recent row and reads its brief, and a read "no
    // mission" removes a chip on its own. `quiet` is attached first so it is never selected or read:
    // its row is the only one that shows what the probe alone decides for a workspace without records.
    const quiet = makeRepo('quiet', false)
    const withMission = makeRepo('alpha', true)
    const without = makeRepo('beta', false)
    await attachRepoAndOpenTerminal(orcaPage, quiet)
    await attachRepoAndOpenTerminal(orcaPage, withMission)
    await attachRepoAndOpenTerminal(orcaPage, without)
    await openResumeCenter(orcaPage)

    // Why the folder name: the row draws the path with '/' on Windows, so the native path never matches.
    const rowA = orcaPage
      .getByTestId('resume-center-workspace')
      .filter({ hasText: path.basename(withMission) })
    const rowB = orcaPage
      .getByTestId('resume-center-workspace')
      .filter({ hasText: path.basename(without) })
    const rowQuiet = orcaPage
      .getByTestId('resume-center-workspace')
      .filter({ hasText: path.basename(quiet) })
    await expect
      .poll(
        async () => {
          await orcaPage.getByTestId('resume-center-refresh').click()
          return [await rowA.count(), await rowB.count(), await rowQuiet.count()]
        },
        { timeout: 60_000, intervals: [2_000], message: 'the three repos never reached the desk' }
      )
      .toEqual([1, 1, 1])

    // Before any click: neither A nor quiet is selected, so their chips come from the probe alone.
    for (const unselected of [rowA, rowQuiet]) {
      await expect(unselected.getByTestId('resume-center-workspace-select')).toHaveAttribute(
        'aria-pressed',
        'false'
      )
    }
    const chipA = rowA.getByTestId('resume-center-workspace-mission-chip')
    await expect(chipA).toBeVisible({ timeout: 15_000 })
    await expect(chipA).toHaveAttribute('data-mission-chip', 'available')
    await expect(chipA).toHaveAccessibleName(new RegExp(path.basename(withMission)))
    await expect(rowQuiet.getByTestId('resume-center-workspace-mission-chip')).toHaveCount(0)
    await expect(rowB.getByTestId('resume-center-workspace-mission-chip')).toHaveCount(0)
    await rowA.scrollIntoViewIfNeeded()
    await rowA.screenshot({ path: 'pr-evidence/resume-center-mission-discovery-row.png' })
    await orcaPage.screenshot({ path: 'pr-evidence/resume-center-mission-discovery.png' })

    const keyA = await rowA.getAttribute('data-workspace-key')
    const keyB = await rowB.getAttribute('data-workspace-key')
    const brief = orcaPage.getByTestId('mission-brief-compact')

    // The chip opens that workspace's brief: records exist, GSD does not, and it says exactly that.
    await chipA.click()
    await expect(rowA.getByTestId('resume-center-workspace-select')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expect(brief).toHaveAttribute('data-workspace-key', keyA ?? '')
    await expect(brief).not.toHaveAttribute('data-brief-status', 'reading', { timeout: 30_000 })
    await expect(brief).toHaveAttribute('data-brief-status', 'unavailable')
    // A brief that could not be read leaves the probe's mark, never a signal it did not compute.
    await expect(chipA).toHaveAttribute('data-mission-chip', 'available')

    // Switching follows selection and does not carry A's brief over.
    await rowB.getByTestId('resume-center-workspace-select').click()
    await expect(brief).toHaveAttribute('data-workspace-key', keyB ?? '')
    await expect(brief).toHaveAttribute('data-brief-status', 'no-mission', { timeout: 30_000 })
    await expect(rowB.getByTestId('resume-center-workspace-mission-chip')).toHaveCount(0)

    // Back to A: its own brief again, one chip, one aside.
    await chipA.click()
    await expect(brief).toHaveAttribute('data-workspace-key', keyA ?? '')
    await expect(orcaPage.getByTestId('mission-brief-compact')).toHaveCount(1)
    await expect(rowA.getByTestId('resume-center-workspace-mission-chip')).toHaveCount(1)
  })
})
