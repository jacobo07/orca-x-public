import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal } from './helpers/orca-restart'

/**
 * The Mission Brief in a running Orca, over real mission records.
 *
 * Unit tests proved the projection from captured fixtures. What only a real app shows: that main
 * runs GSD's tools against the selected workspace, and the brief that reaches the Resume Center
 * describes THAT workspace. Several repos with different records make it discriminating — a brief
 * rendered under the wrong row, or one project's brief for every row, fails.
 *
 * Needs real repos, so it runs only where MISSION_BRIEF_REPOS lists disposable copies of them
 * (path-delimiter separated). Each is added to the isolated test profile, never to a real one.
 * What each brief said is written to pr-evidence/ so it can be checked against gsd-tools directly.
 */

test.setTimeout(600_000)

const REPOS = (process.env.MISSION_BRIEF_REPOS ?? '')
  .split(path.delimiter)
  .map((entry) => entry.trim())
  .filter(Boolean)
// Why the test process's home: the app's HOME is the harness's isolated one, which has no GSD.
const REAL_CLAUDE_DIR = path.join(os.homedir(), '.claude')
const REAL_GSD_CORE = path.join(REAL_CLAUDE_DIR, 'gsd-core')
// Why more than gsd-core: its read commands require ../../../scripts and ../../../package.json.
const GSD_INSTALL_ENTRIES = ['gsd-core', 'scripts', 'package.json']

async function provisionGsdTools(electronApp: ElectronApplication): Promise<void> {
  const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
  for (const entry of GSD_INSTALL_ENTRIES) {
    const source = path.join(REAL_CLAUDE_DIR, entry)
    expect(existsSync(source), `GSD install is missing ${source}`).toBe(true)
    // Why a copy, not a link: nothing the app runs may write into the real installation.
    cpSync(source, path.join(home, '.claude', entry), { recursive: true })
  }
}

async function openResumeCenter(page: Page): Promise<void> {
  await page.locator('[data-workspace-activity="agent-workspace"]').first().click()
  await page.getByTestId('workspace-open-resume-center').click()
  await expect(page.getByTestId('resume-center-page')).toBeVisible({ timeout: 15_000 })
}

function workspaceRow(page: Page, repoPath: string) {
  return page.getByTestId('resume-center-workspace').filter({ hasText: repoPath })
}

test.describe('@mission-brief', () => {
  test.skip(REPOS.length === 0, 'MISSION_BRIEF_REPOS lists no repos on this host')

  test('each Resume Center row opens the brief of its own mission records', async ({
    electronApp,
    orcaPage
  }) => {
    expect(existsSync(REAL_GSD_CORE), `GSD tools are not installed at ${REAL_GSD_CORE}`).toBe(true)
    await provisionGsdTools(electronApp)
    for (const repoPath of REPOS) {
      await attachRepoAndOpenTerminal(orcaPage, repoPath)
    }
    await openResumeCenter(orcaPage)
    mkdirSync('pr-evidence', { recursive: true })

    const seen: Record<string, unknown>[] = []
    for (const repoPath of REPOS) {
      const name = path.basename(repoPath)
      // The expectation comes from the repo on disk, so a brief that reads nothing cannot pass.
      const expected = existsSync(path.join(repoPath, '.planning')) ? 'read' : 'no-mission'
      const row = workspaceRow(orcaPage, repoPath)
      await expect
        .poll(
          async () => {
            await orcaPage.getByTestId('resume-center-refresh').click()
            return row.count()
          },
          { timeout: 60_000, intervals: [2_000], message: `${repoPath} never reached the desk` }
        )
        .toBe(1)
      const workspaceKey = await row.getAttribute('data-workspace-key')

      await row.getByTestId('resume-center-workspace-select').click()
      await expect(row.getByTestId('resume-center-workspace-select')).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      const brief = orcaPage.getByTestId('mission-brief-compact')
      // The aside must describe the selected row, never the previously selected one.
      await expect(brief).toHaveAttribute('data-workspace-key', workspaceKey ?? '')
      await expect(brief).not.toHaveAttribute('data-brief-status', 'reading', { timeout: 90_000 })
      const status = await brief.getAttribute('data-brief-status')

      const text = async (testId: string): Promise<string | null> => {
        const target = brief.getByTestId(testId)
        return (await target.count()) > 0
          ? ((await target.first().textContent()) ?? '').trim()
          : null
      }
      const record: Record<string, unknown> = {
        repo: repoPath,
        workspaceKey,
        expected,
        status,
        signal: await text('mission-brief-signal-label'),
        objective: await text('mission-brief-objective'),
        frontier: await text('mission-brief-frontier'),
        lastVerified: await text('mission-brief-last-verified'),
        nextAction: await text('mission-brief-next-action'),
        blockers: await text('mission-brief-blockers'),
        freshness: await text('mission-brief-freshness'),
        body: status === 'read' ? null : ((await brief.textContent()) ?? '').trim()
      }
      seen.push(record)
      // Written before asserting, so a failing run still leaves what each brief said.
      writeFileSync('pr-evidence/mission-brief-seen.json', `${JSON.stringify(seen, null, 2)}\n`)
      await orcaPage.screenshot({ path: `pr-evidence/mission-brief-${name}-compact.png` })
      expect(status, `${name}: ${String(record.body)}`).toBe(expected)

      if (status === 'read') {
        // A read brief states its signal and frontier, and the row now carries the same signal.
        expect(record.signal, `${name}: a read brief with no signal`).toBeTruthy()
        expect(record.frontier, `${name}: a read brief with no frontier row`).not.toBeNull()
        await expect(row.getByTestId('resume-center-workspace-mission-signal')).toBeVisible()

        await brief.getByTestId('mission-brief-open-full').click()
        const dialog = orcaPage.getByTestId('mission-brief-dialog')
        await expect(dialog.getByTestId('mission-brief-full')).toHaveAttribute(
          'data-workspace-key',
          workspaceKey ?? ''
        )
        await expect(dialog.getByTestId('mission-brief-full')).not.toHaveAttribute(
          'data-brief-status',
          'reading'
        )
        await expect(dialog.getByTestId('mission-brief-signal-label')).toHaveText(
          String(record.signal)
        )
        await orcaPage.screenshot({ path: `pr-evidence/mission-brief-${name}-full.png` })
        await orcaPage.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
      }
    }

    // Distinct records must yield distinct briefs: one brief repeated under every row fails here.
    const read = seen.filter((entry) => entry.status === 'read')
    expect(
      read.length,
      'fewer than two briefs were read, so rows cannot be told apart'
    ).toBeGreaterThan(1)
    expect(new Set(read.map((entry) => entry.workspaceKey)).size).toBe(read.length)
    expect(
      new Set(read.map((entry) => `${entry.objective}|${entry.frontier}|${entry.nextAction}`)).size
    ).toBe(read.length)
  })
})
