import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { expect, type Page } from '@stablyai/playwright-test'

import type { HwfRun } from './hwf-two-host-ssh-target'
import { execInTerminal, waitForTerminalOutput } from './terminal'

export type HwfClientProbe = {
  webGitCommit: 'function' | 'undefined'
  webAgentStatus: 'present' | 'absent'
  sshAgentMenu: 'codex' | 'claude' | 'absent'
}

// Why: the three web/menu facts were inferred, not measured; every later Client B assertion branches on these values.
export async function probeHwfClientSurfaces(
  desktopPage: Page,
  webPage: Page
): Promise<HwfClientProbe> {
  const webGitCommit = await webPage.evaluate(() =>
    typeof window.api?.git?.commit === 'function' ? ('function' as const) : ('undefined' as const)
  )
  const webAgentStatus = await webPage.evaluate(() =>
    'agentStatusByPaneKey' in (window.__store?.getState() ?? {})
      ? ('present' as const)
      : ('absent' as const)
  )
  return { webGitCommit, webAgentStatus, sshAgentMenu: await probeSshAgentMenu(desktopPage) }
}

// Why: the web client URL carries the pairing secret, so the diagnostic prints state and never a URL.
export async function describeWebClientFailure(page: Page): Promise<string> {
  const snapshot = await page
    .evaluate(() => ({
      ready: document.readyState,
      title: document.title,
      origin: location.origin,
      hasStore: Boolean(window.__store),
      hasApi: Boolean(window.api),
      body: document.body?.innerText.slice(0, 400) ?? '',
      sidebarCandidates: [
        '[data-worktree-sidebar]',
        '[data-worktree-sidebar-container]',
        '[data-worktree-id]',
        '[role="listbox"]'
      ].map((selector) => `${selector}=${document.querySelectorAll(selector).length}`),
      worktrees: Object.values(window.__store?.getState().worktreesByRepo ?? {}).flat().length,
      activeWorktreeId: window.__store?.getState().activeWorktreeId ?? null
    }))
    .catch((error: unknown) => ({ evaluateError: String(error) }))
  const runFile = process.env.ORCA_HWF_RUN_FILE
  if (runFile) {
    await page
      .screenshot({ path: path.join(path.dirname(runFile), '15-02-web-client-diag.png') })
      .catch(() => undefined)
  }
  return JSON.stringify(snapshot).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
}

async function probeSshAgentMenu(page: Page): Promise<HwfClientProbe['sshAgentMenu']> {
  await page.getByTestId('tab-bar-new-tab').click({ force: true })
  // Station control: the menu itself must be visible before any item's absence means anything.
  await expect(page.getByRole('menu')).toBeVisible({ timeout: 15_000 })
  const codex = await page
    .getByRole('menuitem', { name: /^Codex(?:\s|$)/i })
    .first()
    .isVisible()
  const claude = await page
    .getByRole('menuitem', { name: /^Claude(?:\s|$)/i })
    .first()
    .isVisible()
  await page.keyboard.press('Escape')
  if (codex) {
    return 'codex'
  }
  return claude ? 'claude' : 'absent'
}

export type HwfProviderPaths = { codex: string; claude: string }

export type RootProc = { pid: number; ppid: number; cwd: string; argv: string }

// Why: the committed provisioner's `procs` verb is the one instrument for "what runs under the root, and where".
export function listRootProcs(run: HwfRun): RootProc[] {
  const result = spawnSync(
    process.execPath,
    [path.join(process.cwd(), 'config', 'scripts', 'hwf-two-host-remote.mjs'), 'procs', run.root],
    { encoding: 'utf8' }
  )
  const procs: RootProc[] = []
  for (const line of (result.stdout ?? '').split(/\r?\n/)) {
    const match = /^PROC (\d+) (-?\d+) (\S+) (.*)$/.exec(line)
    if (match) {
      procs.push({ pid: Number(match[1]), ppid: Number(match[2]), cwd: match[3], argv: match[4] })
    }
  }
  return procs
}

async function waitForRootProc(
  run: HwfRun,
  pattern: RegExp,
  timeoutMs: number
): Promise<RootProc | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = listRootProcs(run).find(
      (proc) => pattern.test(proc.argv) && proc.cwd === run.repo
    )
    if (found) {
      return found
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
  return null
}

async function launchFromNewTab(page: Page, provider: 'codex' | 'claude'): Promise<void> {
  await page.getByTestId('tab-bar-new-tab').click({ force: true })
  const item = page
    .getByRole('menuitem', { name: new RegExp(`^${provider}(?:\\s|$)`, 'i') })
    .first()
  await expect(item).toBeVisible({ timeout: 15_000 })
  await item.click({ force: true })
}

// Part a: the real provider CLI through Orca's normal launch path. No override, no prompt, no login, no credential.
export async function launchProviderOnOwningHost(
  page: Page,
  run: HwfRun,
  probe: HwfClientProbe,
  providers: HwfProviderPaths
): Promise<number | null> {
  const anyProvider = providers.codex.startsWith('/') || providers.claude.startsWith('/')
  if (!anyProvider) {
    console.log('HWF_AGENT_A_LAUNCH=NOT_RUN reason=provider-binary-absent')
    return null
  }
  if (probe.sshAgentMenu === 'absent') {
    console.log('HWF_AGENT_A_LAUNCH=NOT_RUN reason=no-launch-surface-on-ssh-worktree')
    return null
  }
  const launchAs = probe.sshAgentMenu
  if (!providers[launchAs].startsWith('/')) {
    console.log('HWF_AGENT_A_LAUNCH=NOT_RUN reason=provider-binary-absent')
    return null
  }
  await page.evaluate(async (agent) => {
    await window.__store?.getState().updateSettings({ defaultTuiAgent: agent })
  }, launchAs)
  await launchFromNewTab(page, launchAs)
  const proc = await waitForRootProc(run, new RegExp(`(^|[/\\s])${launchAs}(\\s|$)`), 60_000)
  if (!proc) {
    console.log(
      `HWF_AGENT_A_LAUNCH=NOT_OBSERVED provider=${launchAs} reason=no-process-with-cwd-repo`
    )
    throw new Error(`no ${launchAs} process with cwd ${run.repo} under the root`)
  }
  await new Promise((resolve) => setTimeout(resolve, 10_000))
  const stillAlive = listRootProcs(run).some((candidate) => candidate.pid === proc.pid)
  expect(stillAlive).toBe(true)
  console.log(`HWF_AGENT_A_LAUNCH=observed provider=${launchAs} pid=${proc.pid} cwd=${proc.cwd}`)
  return proc.pid
}

// Supplementary only: a stub command proves launch placement, never a provider.
export async function launchStubOnOwningHost(
  page: Page,
  run: HwfRun,
  agent: 'codex' | 'claude'
): Promise<void> {
  const stub = `${run.root}/bin/hwf-agent-stub`
  await page.evaluate(
    async ({ command, agent }) => {
      await window.__store?.getState().updateSettings({
        defaultTuiAgent: agent,
        agentCmdOverrides: { [agent]: command },
        agentDefaultArgs: { [agent]: '' }
      })
    },
    { command: stub, agent }
  )
  await launchFromNewTab(page, agent)
  await waitForTerminalOutput(page, 'HWF_AGENT_STUB_READY', 30_000)
  const proc = await waitForRootProc(run, /hwf-agent-stub/, 30_000)
  expect(proc).not.toBeNull()
  console.log(
    `HWF_AGENT_STUB_LAUNCH=observed pid=${proc!.pid} cwd=${proc!.cwd} (supplementary; not a provider)`
  )
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function splitPrintf(value: string): string {
  const mid = Math.floor(value.length / 2)
  return `printf '%s%s\\n' ${shellQuote(value.slice(0, mid))} ${shellQuote(value.slice(mid))}`
}

export async function readActivePaneKey(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    if (!state || !worktreeId) {
      throw new Error('no active worktree')
    }
    const tabs = state.tabsByWorktree[worktreeId] ?? []
    const tabId =
      state.activeTabType === 'terminal'
        ? state.activeTabId
        : (state.activeTabIdByWorktree?.[worktreeId] ?? tabs[0]?.id)
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
    if (!tabId || !pane) {
      throw new Error('no active terminal pane')
    }
    return `${tabId}:${pane.leafId}`
  })
}

// paneKey null = match on the unique prompt nonce alone: the web client re-keys a delivered row to its own web-terminal-* pane (measured), so key equality is only valid on the desktop.
async function statusRowArrived(
  page: Page,
  paneKey: string | null,
  prompt: string
): Promise<boolean> {
  return page.evaluate(
    ({ paneKey, prompt }) =>
      Object.values(window.__store?.getState().agentStatusByPaneKey ?? {}).some(
        (entry) =>
          (paneKey === null || entry.paneKey === paneKey) &&
          entry.prompt === prompt &&
          entry.agentType === 'codex' &&
          entry.state === 'working'
      ),
    { paneKey, prompt }
  )
}

// Part b: a codex hook posted from the remote PTY to the relay's hook endpoint must reach each client's agent-status store.
export async function postHookAndAwaitStatus(
  desktopPage: Page,
  webPage: Page | null,
  ptyId: string,
  paneKey: string
): Promise<void> {
  const prompt = `hwf p15 hook ${Date.now()}`
  const payload = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt })
  const posted = `HWF_HOOK_POSTED_${Date.now()}`
  await execInTerminal(
    desktopPage,
    ptyId,
    [
      'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
      '  echo __ORCA_AGENT_HOOK_ENV_MISSING__',
      'else',
      `  hook_payload=${shellQuote(payload)}`,
      '  (',
      '    sleep 0.1',
      '    if curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/codex" \\',
      '      -H "Content-Type: application/x-www-form-urlencoded" \\',
      '      -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
      '      --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
      '      --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
      '      --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
      '      --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
      '      --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
      '      --data-urlencode "payload=${hook_payload}" >/dev/null; then',
      `      ${splitPrintf(posted)}`,
      '    fi',
      '  ) &',
      'fi'
    ].join('\n')
  )
  await waitForTerminalOutput(desktopPage, posted, 20_000)
  // Both clients are watched at once: a row can be superseded, so a sequential wait could miss the second client's window.
  const watch = (page: Page, name: string): Promise<void> =>
    expect
      .poll(() => statusRowArrived(page, page === desktopPage ? paneKey : null, prompt), {
        timeout: 20_000,
        message: `hook status did not reach the ${name} agent-status store`
      })
      .toBe(true)
  const desktop = watch(desktopPage, 'desktop')
  const web = webPage ? watch(webPage, 'web') : null
  web?.catch(() => undefined)
  await desktop
  console.log('HWF_HOOK_A=ok')
  if (!webPage || !web) {
    console.log('HWF_HOOK_B=NOT_RUN reason=web-store-has-no-agent-status')
    return
  }
  try {
    await web
  } catch (error) {
    console.log(`HWF_HOOK_B_DIAG ${await describeAgentRows(webPage)}`)
    throw error
  }
  console.log('HWF_HOOK_B=ok')
}

async function describeAgentRows(page: Page): Promise<string> {
  const rows = await page.evaluate(() =>
    Object.entries(window.__store?.getState().agentStatusByPaneKey ?? {}).map(([key, entry]) => ({
      key,
      paneKey: entry.paneKey,
      agentType: entry.agentType,
      state: entry.state
    }))
  )
  return JSON.stringify({ rowCount: rows.length, rows: rows.slice(0, 6) })
}
