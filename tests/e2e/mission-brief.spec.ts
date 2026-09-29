import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
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
    orcaPage
  }) => {
    for (const repoPath of REPOS) {
      await attachRepoAndOpenTerminal(orcaPage, repoPath)
    }
    await openResumeCenter(orcaPage)
    mkdirSync('pr-evidence', { recursive: true })

    const seen: Record<string, unknown>[] = []
    for (const repoPath of REPOS) {
      const name = path.basename(repoPath)
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
        status,
        signal: await text('mission-brief-signal-label'),
        objective: await text('mission-brief-objective'),
        frontier: await text('mission-brief-frontier'),
        lastVerified: await text('mission-brief-last-verified'),
        nextAction: await text('mission-brief-next-action'),
        freshness: await text('mission-brief-freshness'),
        body: status === 'read' ? null : ((await brief.textContent()) ?? '').trim()
      }

      if (status === 'read') {
        // A read brief states its signal and frontier, and the row now carries the same signal.
        expect(record.signal, `${name}: a read brief with no signal`).toBeTruthy()
        expect(record.frontier, `${name}: a read brief with no frontier row`).not.toBeNull()
        await expect(row.getByTestId('resume-center-workspace-mission-signal')).toBeVisible()
        await orcaPage.screenshot({ path: `pr-evidence/mission-brief-${name}-compact.png` })

        await brief.getByTestId('mission-brief-open-full').click()
        const dialog = orcaPage.getByTestId('mission-brief-dialog')
        await expect(dialog.getByTestId('mission-brief-full')).toHaveAttribute(
          'data-workspace-key',
          workspaceKey ?? ''
        )
        await expect(dialog.getByTestId('mission-brief-signal-label')).toHaveText(
          String(record.signal)
        )
        await orcaPage.screenshot({ path: `pr-evidence/mission-brief-${name}-full.png` })
        await orcaPage.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
      } else {
        await orcaPage.screenshot({ path: `pr-evidence/mission-brief-${name}-compact.png` })
      }
      seen.push(record)
    }

    writeFileSync('pr-evidence/mission-brief-seen.json', `${JSON.stringify(seen, null, 2)}\n`)
    // Distinct records must yield distinct briefs: one brief repeated under every row fails here.
    const read = seen.filter((entry) => entry.status === 'read')
    expect(new Set(read.map((entry) => entry.workspaceKey)).size).toBe(read.length)
    expect(new Set(read.map((entry) => `${entry.objective}|${entry.frontier}`)).size).toBe(
      read.length
    )
  })
})
