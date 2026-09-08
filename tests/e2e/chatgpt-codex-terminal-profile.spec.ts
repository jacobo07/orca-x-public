/**
 * The terminal chooser must offer OpenAI Codex under the name users know it by.
 *
 * Why an E2E and not just the unit test on the profile registry: the registry can be correct while
 * nothing renders it. This drives the same "+" menu a user clicks and asserts on the accessible
 * name, so a chooser that stopped consuming the canonical profile set fails here.
 *
 * Why the assertions match /ChatGPT/ rather than a full label: the menu item reads
 * "New Terminal: <profile>" and that prefix is localized, so a Spanish host renders "Nuevo
 * terminal: ChatGPT". The brand itself is pinned to English by the never-translate policy, which
 * makes it the one locale-stable thing to match on — and it is why the "+" is located by testid
 * rather than by its (localized) accessible name.
 */

import { test, expect } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'
import { waitForSessionReady, waitForActiveWorktree, getActiveWorktreeId } from './helpers/store'

const DETECTED_AGENTS = ['claude', 'codex'] as const

/**
 * The launch identity a tab was created under. Read straight from the store rather than through
 * `getWorktreeTabs`, which projects only id and title — this contract is precisely about the field
 * that projection drops.
 */
async function getLaunchIdentities(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate((id) => {
    const tabs = window.__store?.getState().tabsByWorktree[id] ?? []
    return tabs.map(
      (tab: { launchProfileId?: string | null; launchAgent?: string | null }) =>
        `${tab.launchProfileId ?? ''}|${tab.launchAgent ?? ''}`
    )
  }, worktreeId)
}

/**
 * Pin the detected set so the chooser's contents do not depend on which agents happen to be
 * installed on the machine running the suite.
 *
 * Why it waits first: detection is kicked off on mount and only refetches while the value is null.
 * Seeding before that in-flight probe resolves lets it overwrite the seed a moment later, and the
 * row then goes missing for a reason that has nothing to do with the code under test.
 */
async function pinDetectedAgents(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__store?.getState().detectedAgentIds !== null), {
      timeout: 30_000,
      message: 'Agent detection never settled, so a seeded set could still be overwritten'
    })
    .toBe(true)
  await page.evaluate((agents) => {
    window.__store.setState({ detectedAgentIds: [...agents] })
  }, DETECTED_AGENTS)
}

/**
 * Opens the tab-bar "+" menu and proves it opened.
 *
 * The intermediate assertion matters: without it, a menu that never opened and a menu that opened
 * without the ChatGPT row fail identically, and the second is the only one that is about this code.
 */
async function openCreateMenu(page: Page): Promise<void> {
  const plus = page.getByTestId('tab-bar-new-tab')
  // Why retried: a click into a tab bar that is still hydrating gets swallowed, and the menu then
  // never opens. Retrying the trigger characterises that as the flake it is; the assertion below
  // still fails loudly if the menu genuinely cannot open, so this cannot paper over a real break.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await plus.click({ force: attempt > 1 })
    try {
      await page.waitForSelector('[role="menuitem"]', { timeout: 8_000 })
      return
    } catch {
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(1_000)
    }
  }
  await expect
    .poll(() => page.getByRole('menuitem').count(), {
      timeout: 10_000,
      message: 'The "+" create menu did not open, so its contents were never observed'
    })
    .toBeGreaterThan(0)
}

test.describe('ChatGPT terminal profile', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await pinDetectedAgents(orcaPage)
  })

  test('offers Codex as ChatGPT, and not under its runtime name', async ({ orcaPage }) => {
    await openCreateMenu(orcaPage)

    // Why `.first()` plus a count floor rather than a bare toBeVisible: this menu carries two
    // independent surfaces that both list agents — the canonical profile rows ("New Terminal: X")
    // and the quick-launch rows ("Launch X in a new terminal"). Both matching is the convergence
    // property, not a duplicate: they read one catalog, so they must agree on the label.
    const chatGptRows = orcaPage.getByRole('menuitem', { name: /ChatGPT/ })
    await expect(chatGptRows.first()).toBeVisible()
    await expect.poll(() => chatGptRows.count()).toBeGreaterThan(0)
    // The runtime name must never surface to the user: the brand is the label, `codex` is only the
    // identity underneath it.
    await expect(orcaPage.getByRole('menuitem', { name: /Codex/ })).toHaveCount(0)
  })

  test('puts ChatGPT directly under Claude, ahead of the shells', async ({ orcaPage }) => {
    await openCreateMenu(orcaPage)
    const items = await orcaPage.getByRole('menuitem').allTextContents()

    // Index-based rather than "is present": the ask was adjacency, and a row can be present while
    // sitting three shells further down.
    const claude = items.findIndex((text) => /terminal.*Claude/i.test(text))
    const chatGpt = items.findIndex((text) => /terminal.*ChatGPT/i.test(text))
    const firstShell = items.findIndex((text) => /terminal.*(CMD|PowerShell|Git Bash)/i.test(text))

    expect(claude).toBeGreaterThanOrEqual(0)
    expect(chatGpt).toBe(claude + 1)
    expect(firstShell).toBeGreaterThan(chatGpt)
  })

  test('launches the row under the codex runtime identity', async ({ orcaPage }) => {
    const worktreeId = await getActiveWorktreeId(orcaPage)
    expect(worktreeId).toBeTruthy()
    // Why the rail and not the tab bar: choosing an agent opens a terminal in the terminal rail,
    // not a workspace tab. Counting `sortable-tab` here reported "nothing happened" while the rail
    // had in fact gained a session.
    const railTerminals = orcaPage.getByRole('button', { name: /^Terminal \d+$/ })
    const railBefore = await railTerminals.count()

    await openCreateMenu(orcaPage)
    await orcaPage.getByRole('menuitem', { name: /ChatGPT/ }).first().click({ force: true })

    await expect
      .poll(() => railTerminals.count(), {
        timeout: 20_000,
        message: 'Choosing ChatGPT did not open a terminal in the terminal rail'
      })
      .toBeGreaterThan(railBefore)

    // The identity has no DOM representation, and it is the half of this contract that must not
    // follow the label: a persisted tab resolves against this id after any future rename.
    await expect
      .poll(() => getLaunchIdentities(orcaPage, worktreeId as string), {
        timeout: 15_000,
        message: 'The ChatGPT row did not create a tab owned by the codex agent identity'
      })
      .toEqual(expect.arrayContaining([expect.stringContaining('codex')]))
  })
})
