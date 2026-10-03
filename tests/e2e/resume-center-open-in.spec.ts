import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal } from './helpers/orca-restart'

/**
 * Open in (W5): the Resume Center hands the SELECTED workspace to the user's own "Open in" apps.
 *
 * The launch is the sidebar's authority (`shell:openInExternalEditor`); here its main-side handler is
 * replaced by a recorder, so the spec judges exactly what the page asked for and starts no editor.
 * Two repos: the page auto-selects the most recent one, so choosing the OTHER proves the request
 * follows selection, not position.
 */

test.setTimeout(300_000)

type OpenRequest = { path: string; command?: string; connectionId?: string | null }

function makeRepo(name: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `orca-e2e-open-in-${name}-`))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  git('init', '-q')
  git('config', 'user.email', 'e2e@orca.test')
  git('config', 'user.name', 'orca e2e')
  writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`)
  git('add', '-A')
  git('commit', '-q', '-m', 'seed')
  return dir
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const real = realpathSync.native(p)
    return process.platform === 'win32' ? real.toLowerCase() : real
  }
  return norm(a) === norm(b)
}

test.describe('@resume-center-open-in', () => {
  test('Open in sends the selected workspace, by its own path, to the chosen app', async ({
    orcaPage,
    electronApp
  }) => {
    const first = makeRepo('first')
    const second = makeRepo('second')
    await attachRepoAndOpenTerminal(orcaPage, first)
    await attachRepoAndOpenTerminal(orcaPage, second)
    await orcaPage.evaluate(() =>
      window.__store!.getState().updateSettingsOrThrow({
        openInApplications: [{ id: 'cursor', label: 'Cursor', command: 'cursor' }]
      })
    )
    await electronApp.evaluate(({ ipcMain }) => {
      const calls: unknown[] = []
      ;(globalThis as { __openInCalls?: unknown[] }).__openInCalls = calls
      ipcMain.removeHandler('shell:openInExternalEditor')
      ipcMain.handle('shell:openInExternalEditor', (_event, request) => {
        calls.push(request)
        return { ok: true }
      })
    })
    const calls = (): Promise<OpenRequest[]> =>
      electronApp.evaluate(
        () => ((globalThis as { __openInCalls?: unknown[] }).__openInCalls ?? []) as OpenRequest[]
      )

    await orcaPage.locator('[data-workspace-activity="agent-workspace"]').first().click()
    await orcaPage.locator('[data-workspace-nav-item="resume"]').click()
    await expect(orcaPage.getByTestId('resume-center-page')).toBeVisible({ timeout: 15_000 })
    const row = (dir: string) =>
      orcaPage.getByTestId('resume-center-workspace').filter({ hasText: path.basename(dir) })
    await expect
      .poll(
        async () => {
          await orcaPage.getByTestId('resume-center-refresh').click()
          return [await row(first).count(), await row(second).count()]
        },
        { timeout: 60_000, intervals: [2_000], message: 'the two repos never reached the desk' }
      )
      .toEqual([1, 1])

    // Precondition: the auto-selected row is the OTHER one, so following position would be wrong.
    const firstSelect = row(first).getByTestId('resume-center-workspace-select')
    await expect(firstSelect).toHaveAttribute('aria-pressed', 'false')
    await firstSelect.click()
    await expect(firstSelect).toHaveAttribute('aria-pressed', 'true')

    const more = orcaPage.getByTestId('resume-center-more-options')
    await expect(more).toBeEnabled()
    await expect(more).toContainText(path.basename(first))
    await more.click()
    const openIn = orcaPage.getByTestId('resume-center-more-open-in')
    await expect(openIn).toBeVisible()
    await openIn.click()
    const menu = orcaPage.getByTestId('resume-center-more-open-in-menu')
    await expect(menu).toBeVisible()
    // Positive control: the configured app, the file manager and "Customize apps...", as in the sidebar.
    await expect(menu.getByRole('menuitem')).toHaveCount(3)
    await menu.getByRole('menuitem', { name: 'Cursor' }).click()

    await expect.poll(async () => (await calls()).length, { timeout: 10_000 }).toBe(1)
    const [request] = await calls()
    expect(request.command).toBe('cursor')
    expect(request.connectionId ?? null).toBeNull()
    expect(samePath(request.path, first), `asked for ${request.path}, expected ${first}`).toBe(true)
  })
})
