import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { focusActiveTerminalInput, waitForTerminalOutput } from './terminal'

export const GOLDEN_STUB_READY_MARKER = 'GOLDEN_STUB_AGENT_READY'
export const GOLDEN_STUB_EXIT_MARKER = 'GOLDEN_STUB_AGENT_EXITED'

const fixtureDir = path.join(process.cwd(), 'tests', 'e2e', 'fixtures', 'golden-stub-agent')

export function getGoldenStubAgentLaunchEnv(): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  return {
    [pathKey]: [fixtureDir, process.env[pathKey] ?? ''].filter(Boolean).join(path.delimiter)
  }
}

export async function configureGoldenStubAgent(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('Orca store is unavailable')
    }
    await store.getState().updateSettings({
      defaultTuiAgent: 'codex',
      agentCmdOverrides: { codex: 'golden-stub-agent' },
      agentDefaultArgs: { codex: '' }
    })
  })
}

export async function launchGoldenStubAgentFromNewTab(page: Page): Promise<void> {
  // Why: the codex agent is offered as ChatGPT, a brand label that is never translated.
  const launchOption = page.getByRole('menuitem', { name: /^ChatGPT(?:\s|$)/i }).first()
  // Why no force: the titlebar still shifts after startup, and a forced click at a stale box hit the app menu.
  await expect(async () => {
    if (!(await launchOption.isVisible())) {
      await page.getByRole('button', { name: 'New tab' }).click({ timeout: 3_000 })
    }
    await expect(launchOption).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
  await launchOption.click({ force: true })
  await focusActiveTerminalInput(page)
  await waitForTerminalOutput(page, GOLDEN_STUB_READY_MARKER, 20_000)
}
