/**
 * DWS-P2 opt-in desktop-attach evidence harness (CTX-CLI-1, CTX-EXP-2, CTX-MEAS-4). Skipped unless
 * ORCA_DWS_P2_TARGET=remote. Proves (a) the real laptop desktop pairs to the GEX44 serve through
 * AddRemoteHostDialog's SSH-tunnel checkbox path, (b) a terminal opened on that paired runtime's
 * worktree shows output that could only have come from GEX44 (nonce + orca-svc + kobicraft-gex44),
 * and (c)/(d) measures stream latency through that remote terminal against a same-harness local
 * floor.
 *
 * Uses `orcaPage`/`electronApp` from ./helpers/orca-app -- never Playwright's bare `page`
 * (AGENTS.md; enforced by config/scripts/check-e2e-fixture-binding.mjs).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { attachDwsRemoteRuntime } from './helpers/dws-remote-runtime-attach'
import { focusActiveTerminalInput, waitForActivePanePtyId } from './helpers/terminal'

// Why: later steps put a live pairing code on screen; this harness never needs a
// trace/screenshot and must not risk capturing one (T-02-04c).
test.use({ trace: 'off', screenshot: 'off', seedTestRepo: false })

const PROBE_COUNT = 7
const PROBE_TIMEOUT_MS = 15_000

type TabIdLookup = { tabId: string; nonce: string }

async function resolveActiveTabIdForNewestTerminal(
  page: Page,
  beforeIds: string[]
): Promise<string> {
  let tabId = ''
  await expect
    .poll(
      async () => {
        tabId = await page.evaluate((oldIds) => {
          const state = window.__store?.getState()
          const worktreeId = state?.activeWorktreeId
          return (
            (worktreeId ? state?.tabsByWorktree[worktreeId] : [])?.find(
              (tab) => !oldIds.includes(tab.id)
            )?.id ?? ''
          )
        }, beforeIds)
        return tabId
      },
      { timeout: 30_000, message: 'New Terminal did not create a new tab' }
    )
    .not.toBe('')
  return tabId
}

/**
 * Opens a new PLAIN SHELL terminal tab on whatever worktree is currently active, via the real UI
 * action -- explicitly through "Choose terminal profile" (TerminalPanelToolbar.tsx), never the
 * ambient "New Terminal" default. Found via diagnostic buffer dumps (two consecutive
 * waitForBufferContains timeouts): this real, persistent desktop's `defaultProfileId` resolved to
 * an AGENT profile (Claude Code's own onboarding wizard rendered in the pane), not a shell, because
 * some earlier real interactive session on this same machine set it as the last-used/default
 * terminal launch profile. `New Terminal`'s plus button and the tab-bar's "New tab" -> "New
 * Terminal" menu both launch `defaultProfileId` unconditionally; only the explicit per-profile menu
 * (data-terminal-profile-kind) can name a non-agent profile regardless of what the ambient default
 * currently is.
 */
async function openNewTerminalTab(
  page: Page
): Promise<{ tabId: string }> {
  const before = await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    return worktreeId ? (state?.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id) : []
  })
  await page
    .locator('[data-terminal-toolbar-action="new-terminal-menu"]')
    .first()
    .click({ force: true })
  const shellProfileItem = page.locator('[data-terminal-profile-kind]:not([data-terminal-profile-kind="agent"])').first()
  await expect(shellProfileItem).toBeVisible({ timeout: 10_000 })
  await shellProfileItem.click()
  const tabId = await resolveActiveTabIdForNewestTerminal(page, before)
  await waitForActivePanePtyId(page, 30_000)
  return { tabId }
}

/** Waits (rAF-polled) for `expected` to appear in the active pane's serialized xterm buffer. */
async function waitForBufferContains(
  page: Page,
  tabId: string,
  expected: string,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<void> {
  await page.waitForFunction(
    ({ tabId, expected }) => {
      const manager = window.__paneManagers?.get(tabId)
      const activePane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      const text = activePane?.serializeAddon?.serialize?.() ?? ''
      return text.includes(expected)
    },
    { tabId, expected },
    { polling: 'raf', timeout: timeoutMs }
  )
}

/**
 * Runs PROBE_COUNT marker round-trips into the active terminal tab: type an expression that
 * evaluates to a distinct output line (so the shell's own local-echo of the INPUT text can never
 * satisfy the wait -- only the evaluated OUTPUT line can), time from just-before-Enter to the
 * output line appearing in the rendered buffer.
 */
async function measureStreamLatency(
  page: Page,
  tabId: string,
  nonce: string,
  buildInputLine: (n: number, expected: string) => string
): Promise<number[]> {
  const values: number[] = []
  for (let n = 1; n <= PROBE_COUNT; n += 1) {
    const expected = `MARK-${nonce}-${n * 7}`
    const inputLine = buildInputLine(n, expected)
    await focusActiveTerminalInput(page)
    await page.keyboard.insertText(inputLine)
    const startedAt = performance.now()
    // eslint-disable-next-line no-await-in-loop -- sequential marker round-trips by design.
    await page.keyboard.press('Enter')
    // eslint-disable-next-line no-await-in-loop -- must observe this probe before sending the next.
    await waitForBufferContains(page, tabId, expected)
    values.push(performance.now() - startedAt)
  }
  return values
}

test.describe('DWS-P2 remote desktop attach', () => {
  test.skip(
    process.env.ORCA_DWS_P2_TARGET !== 'remote',
    'opt-in DWS-P2 remote-attach harness -- set ORCA_DWS_P2_TARGET=remote to run'
  )

  test('attach, identity round-trip, and stream latency (remote vs local floor)', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(20 * 60_000)

    const pairingFile = process.env.ORCA_DWS_P2_PAIRING_FILE
    const checkout = process.env.ORCA_DWS_P2_CHECKOUT
    const runDir = process.env.ORCA_DWS_P2_RUN_DIR
    const envName = process.env.ORCA_DWS_P2_ENV_NAME ?? 'gex44-svc'
    if (!pairingFile || !checkout || !runDir) {
      throw new Error(
        'ORCA_DWS_P2_PAIRING_FILE, ORCA_DWS_P2_CHECKOUT and ORCA_DWS_P2_RUN_DIR are all required'
      )
    }
    mkdirSync(runDir, { recursive: true })

    await expect(orcaPage.locator('[data-workspace-activity-rail]')).toBeVisible({
      timeout: 60_000
    })

    // (a) Attach -- this IS the criterion-3 proof (a live status.get round-trip over the tunnel
    // gates the save; see dws-remote-runtime-attach.ts).
    const attachResult = await attachDwsRemoteRuntime(orcaPage, { name: envName, pairingFile })
    expect(attachResult.environmentId).toBeTruthy()

    // (b) Open the service checkout as a project on the paired host, through the same UI chain
    // already proven by tests/e2e/pr11346-selected-runtime-add.spec.ts.
    await orcaPage
      .getByRole('button', { name: /Add Project/i })
      .first()
      .click()
    const addProjectDialog = orcaPage.getByRole('dialog', { name: /Add a project/i })
    await expect(addProjectDialog).toBeVisible({ timeout: 10_000 })
    const hostCombobox = addProjectDialog.getByRole('combobox')
    if (!(await hostCombobox.textContent())?.includes(envName)) {
      await hostCombobox.click()
      await orcaPage.locator('[cmdk-item]').filter({ hasText: envName }).click()
    }
    await expect(hostCombobox).toContainText(envName)

    await addProjectDialog.getByRole('button', { name: /Browse folder|Browse host/i }).click()
    const browseDialog = orcaPage.getByRole('dialog', { name: /Browse host filesystem/i })
    await expect(browseDialog).toBeVisible({ timeout: 15_000 })
    await browseDialog.getByRole('button', { name: /^Cancel$/i }).click()
    const manualDialog = orcaPage.getByRole('dialog', { name: /Open host project/i })
    await expect(manualDialog.locator('#server-project-path')).toBeVisible()
    await manualDialog.locator('#server-project-path').fill(checkout)
    await manualDialog.getByRole('button', { name: /Add Git Project/i }).click()
    await expect(manualDialog).toBeHidden({ timeout: 30_000 })

    const activatedOnHost = { value: false }
    await expect
      .poll(
        async () => {
          const activeHostId = await orcaPage.evaluate(
            () => window.__store?.getState().activeWorkspaceExecutionHostId ?? null
          )
          activatedOnHost.value = activeHostId === `runtime:${attachResult.environmentId}`
          return activatedOnHost.value
        },
        { timeout: 30_000, message: 'checkout did not activate on the paired runtime host' }
      )
      .toBe(true)

    // Identity round-trip: a terminal opened via the real UI, on the real runtime-owned
    // worktree, whose output can only have come from GEX44's own shell.
    const identityNonce = `attach${Date.now().toString(36)}`
    const identityTab = await openNewTerminalTab(orcaPage)

    // waitForActivePanePtyId proves a ptyId was ASSIGNED client-side; it does not prove the
    // remote shell is READY to receive input yet (spawn + rc file + SSH-tunnel relay round-trip).
    // Found via diagnostic buffer dumps: input sent immediately after ptyId assignment was
    // silently dropped -- the buffer was still empty at that point, and the real bash prompt
    // (`orca-svc@kobicraft-gex44:~/...$`) only rendered ~45s later, by which time our keystrokes
    // were long gone. Wait for ANY rendered content -- i.e. the shell is actually live -- before
    // sending the identity command.
    await waitForBufferContains(orcaPage, identityTab.tabId, '$', 90_000)

    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.insertText(`echo DWS-P2-ATTACH-${identityNonce}; id -un; hostname`)
    await orcaPage.keyboard.press('Enter')
    await waitForBufferContains(orcaPage, identityTab.tabId, `DWS-P2-ATTACH-${identityNonce}`, 30_000)
    await waitForBufferContains(orcaPage, identityTab.tabId, 'orca-svc', 15_000)
    await waitForBufferContains(orcaPage, identityTab.tabId, 'kobicraft-gex44', 15_000)

    // (c) Stream latency, remote: 7 marker round-trips into the same terminal, bash form.
    const remoteNonce = `lat${Date.now().toString(36)}r`
    const remoteValues = await measureStreamLatency(
      orcaPage,
      identityTab.tabId,
      remoteNonce,
      (n) => `echo MARK-${remoteNonce}-$((${n}*7))`
    )
    writeFileSync(
      path.join(runDir, 'stream-latency-remote-raw.json'),
      JSON.stringify(remoteValues, null, 2)
    )

    // (d) Stream latency, local floor: same 7 probes, in a LOCAL terminal of this same desktop
    // (this repo's own checkout, PowerShell form).
    const repoRoot = process.cwd()
    const rpcModule = await import('../../config/scripts/live-remote-freeze-rpc.mjs')
    // Why from the electronApp fixture, not an env var: local:true dispatches must land on the
    // SAME already-running desktop instance this orcaPage belongs to.
    const localUserDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const localRpc = rpcModule.createOrcaRpc({
      envName: 'dws-p2-local-floor',
      env: {
        ...process.env,
        ORCA_DEV_REPO_ROOT: repoRoot,
        ORCA_CLI_COMMAND: 'orca-dev',
        ORCA_USER_DATA_PATH: localUserDataDir
      }
    })
    localRpc.orcaJsonSync(['repo', 'add', '--path', repoRoot], { local: true, timeoutMs: 60_000 })
    localRpc.orcaJsonSync(
      ['terminal', 'create', '--worktree', `path:${repoRoot}`, '--title', 'dws-p2-local-floor', '--focus'],
      { local: true, timeoutMs: 30_000 }
    )
    const before = await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      return worktreeId ? (state?.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id) : []
    })
    const localTabId = await resolveActiveTabIdForNewestTerminal(orcaPage, before).catch(
      async () => {
        // The focused terminal may already be the active tab by the time we poll; fall back to
        // whatever tab is active now.
        return orcaPage.evaluate(() => {
          const state = window.__store?.getState()
          const worktreeId = state?.activeWorktreeId
          return worktreeId
            ? (state?.activeTabIdByWorktree?.[worktreeId] ?? '')
            : ''
        })
      }
    )
    await waitForActivePanePtyId(orcaPage, 30_000)
    const localNonce = `lat${Date.now().toString(36)}l`
    const localValues = await measureStreamLatency(
      orcaPage,
      localTabId,
      localNonce,
      (n) => `'MARK-${localNonce}-' + (${n}*7)`
    )
    writeFileSync(
      path.join(runDir, 'stream-latency-local-floor-raw.json'),
      JSON.stringify(localValues, null, 2)
    )

    const manifest: TabIdLookup & { checkout: string; envName: string } = {
      tabId: identityTab.tabId,
      nonce: identityNonce,
      checkout,
      envName
    }
    writeFileSync(path.join(runDir, 'attach-manifest.json'), JSON.stringify(manifest, null, 2))
  })
})
