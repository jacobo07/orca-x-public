/**
 * Which shells let the host see an unsent line. `inputSincePrompt` is fed by the OSC 133 prompt
 * markers, so a shell that emits none can never answer, and on those the draft is protected only by
 * the renderer's own flag — which a reload destroys.
 *
 * This is a characterization: it records today's answers so the matrix in
 * docs/reference/terminal-unsent-input-evidence.md cannot drift from the product silently. A shell
 * that starts answering should turn this red and gain protection, not be quietly assumed.
 */
import { existsSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'

type Reading = { promptState: unknown; beforeInput: unknown; afterInput: unknown }

async function readShell(
  page: Page,
  worktreeId: string,
  shellOverride: string | undefined
): Promise<Reading> {
  const tabId = await page.evaluate(
    ({ wt, shell }) => {
      const store = window.__store!
      const created = store.getState().createTab(wt, undefined, shell) as
        | string
        | { id: string }
        | undefined
      const id = typeof created === 'string' ? created : created?.id
      if (!id) {
        throw new Error(`ORCA-E2E-PRECONDITION-FAILED [create-tab] ${shell ?? 'default'}`)
      }
      // A pane spawns its PTY when it mounts, which needs the tab to be the active one.
      store.getState().activateTab(id, { worktreeId: wt })
      store.getState().setActiveTab(id)
      return id
    },
    { wt: worktreeId, shell: shellOverride }
  )
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  const ptyId = await page.evaluate(async (id) => {
    const store = window.__store!
    const started = Date.now()
    while (Date.now() - started < 30_000) {
      const ids = store.getState().ptyIdsByTabId[id] ?? []
      if (ids[0]) {
        return ids[0]
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error(`ORCA-E2E-PRECONDITION-FAILED [pty-start] ${id} never spawned`)
  }, tabId)

  const inspect = async (): Promise<Record<string, unknown>> =>
    (await page.evaluate((id) => window.api.pty.inspectProcess(id), ptyId)) as Record<
      string,
      unknown
    >
  // Give the shell time to reach a prompt and, for a marker-emitting shell, to report it.
  await expect
    .poll(async () => (await inspect()).foregroundProcess !== undefined, {
      timeout: 30_000,
      message: 'the host knows the foreground process'
    })
    .toBe(true)
  await page.waitForTimeout(3_000)
  const before = await inspect()
  await page.evaluate((id) => window.api.pty.write(id, 'echo matrix-draft'), ptyId)
  await page.waitForTimeout(2_000)
  const after = await inspect()
  return {
    promptState: before.promptState,
    beforeInput: before.inputSincePrompt,
    afterInput: after.inputSincePrompt
  }
}

test('records which shells can report an unsent line', async ({ orcaPage }) => {
  test.setTimeout(180_000)
  test.skip(process.platform !== 'win32', 'the shells measured here are the Windows set')
  const page = orcaPage
  await waitForSessionReady(page)
  const worktreeId = await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)

  // The default shell: markers, so the host sees the line. Three product specs rely on this.
  const preferred = await readShell(page, worktreeId, undefined)
  expect(preferred.afterInput, 'the default shell must report a typed line').toBe('typed')
  expect(preferred.beforeInput).toBe('clean')

  // cmd.exe: no OSC 133, so no answer at all — before or after typing.
  const cmd = await readShell(page, worktreeId, 'cmd.exe')
  expect(cmd.beforeInput).toBeUndefined()
  expect(
    cmd.afterInput,
    'cmd.exe has no markers, so a draft there is renderer-only'
  ).toBeUndefined()

  // Git Bash, where present: measured rather than assumed to match cmd.exe — Orca injects shell
  // integration per shell family, so bash could legitimately answer where cmd.exe cannot.
  const gitBash = existsSync(GIT_BASH) ? await readShell(page, worktreeId, GIT_BASH) : null
  if (gitBash) {
    expect(
      [undefined, 'clean', 'typed'],
      'an unexpected answer means the matrix doc is now wrong'
    ).toContain(gitBash.afterInput)
  }

  console.log(
    `[shell-matrix] preferred=${String(preferred.promptState)}/${String(preferred.afterInput)} ` +
      `cmd=${String(cmd.promptState)}/${String(cmd.afterInput)} ` +
      `gitbash=${gitBash ? `${String(gitBash.promptState)}/${String(gitBash.afterInput)}` : 'absent'}`
  )
})
