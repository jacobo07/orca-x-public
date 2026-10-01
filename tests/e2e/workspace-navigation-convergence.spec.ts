import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

// PRODUCT REALITY — Workspace convergence W2 (docs/reference/workspace-convergence.md §2).
//
// One walk through every Workspace destination in the real app, asserting single ownership at each
// step: the global navigation never changes, Workspace opens on Resume, Workspace's own navigation
// owns Agents / Threads / Projects / Backlog, the open agent's context lives in the frame's column,
// and the controls the frame replaced (roster tabs, roster Resume button) no longer exist.

test.setTimeout(300_000)

const AGENT_NAME = 'Convergence Probe'
const WORKSPACE_ENTRY = '[data-workspace-activity="agent-workspace"]'
const FRAME = '[data-workspace-frame]'
const FRAME_COLUMN = '[data-workspace-frame-column]'

type GlobalNav = { count: number; items: string[] }

async function readGlobalNav(page: Page): Promise<GlobalNav> {
  return page.evaluate(() => {
    const navs = [...document.querySelectorAll<HTMLElement>('[data-global-nav]')].filter(
      (nav) => nav.getBoundingClientRect().width > 0
    )
    return {
      count: navs.length,
      items: navs[0]
        ? [...navs[0].querySelectorAll('[data-global-nav-item]')].map(
            (node) => node.getAttribute('data-global-nav-item') ?? ''
          )
        : []
    }
  })
}

async function activeView(page: Page): Promise<string> {
  return page.evaluate(() => window.__store!.getState().activeView)
}

async function expectDestination(page: Page, destination: string): Promise<void> {
  await expect(page.locator(FRAME)).toHaveAttribute('data-workspace-destination', destination)
  await expect(page.locator(`[data-workspace-nav-item="${destination}"]`)).toHaveAttribute(
    'aria-current',
    'page'
  )
  // Workspace stays the current global entry on every one of its destinations.
  await expect(page.locator(WORKSPACE_ENTRY).first()).toHaveAttribute('aria-current', 'page')
}

async function setWindow(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height),
    { width, height }
  )
}

test('every Workspace destination renders in one frame under one unchanged global navigation', async ({
  testRepoPath
}, testInfo) => {
  const session = createRestartSession(testInfo)
  try {
    const { app, page } = await session.launch()
    await attachRepoAndOpenTerminal(page, testRepoPath)
    await setWindow(app, 1700, 960)

    const baseline = await readGlobalNav(page)
    // Positive control: the instrument found the column, so later equality is not empty == empty.
    expect(baseline.count).toBe(1)
    expect(baseline.items).toEqual(expect.arrayContaining(['home', 'agent-workspace', 'settings']))
    const expectShellUnchanged = async (step: string): Promise<void> => {
      const reading = await readGlobalNav(page)
      expect(reading.count, `${step}: global navigation columns`).toBe(1)
      expect(reading.items, `${step}: global destinations`).toEqual(baseline.items)
    }

    // ── Home: the global entry lands on Resume, never on the conversation roster ────────────────
    await page.locator(WORKSPACE_ENTRY).first().click()
    await expect.poll(() => activeView(page)).toBe('resumeCenter')
    await expectDestination(page, 'resume')
    await expectShellUnchanged('resume')
    // The frame's column holds Workspace navigation at wide widths.
    const wideNav = page.locator(`${FRAME_COLUMN} [data-workspace-nav="list"]`)
    await expect(wideNav).toBeVisible()
    const destinationCount = await wideNav.locator('[data-workspace-nav-item]').count()
    expect(destinationCount).toBeGreaterThanOrEqual(5)
    // The owners the frame replaced are gone, everywhere in the window.
    await expect(page.locator('[data-testid^="workspace-tab-"]')).toHaveCount(0)
    await expect(page.getByTestId('workspace-open-resume-center')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('w2-resume.png') })

    // ── Agents ──────────────────────────────────────────────────────────────────────────────────
    await page.locator('[data-workspace-nav-item="agents"]').click()
    await expect(page.getByTestId('conversations-page')).toBeVisible()
    await expectDestination(page, 'agents')
    await expect(page.getByTestId('workspace-roster')).toHaveAttribute('data-roster-list', 'agents')
    await expectShellUnchanged('agents')
    // One exit: the frame header's, not a second one in the roster.
    await expect(page.getByTestId('workspace-exit')).toHaveCount(1)

    await page.getByTestId('workspace-new-agent').click()
    await page.getByTestId('new-agent-name').fill(AGENT_NAME)
    await page.getByTestId('new-agent-role').fill('walks every Workspace destination')
    await page.getByTestId('new-agent-submit').click()
    await expect(page.getByTestId('new-agent-dialog')).toHaveCount(0)
    const header = page.getByTestId('agent-chat-header')
    await expect(header).toHaveAttribute('data-lookup-status', 'found')
    const agentId = await header.getAttribute('data-agent-id')
    expect(agentId).toMatch(/^agent_/)

    // The open agent is the breadcrumb's current page.
    await expect(page.locator(`${FRAME} header nav [aria-current="page"]`)).toHaveText(AGENT_NAME)
    // Its context has exactly one owner: the frame column, not a rail inside the chat surface.
    await expect(page.getByTestId('agent-context-rail')).toHaveCount(1)
    await expect(page.locator(`${FRAME_COLUMN} [data-testid="agent-context-rail"]`)).toBeVisible()
    await expect(
      page.locator('[data-testid="conversations-page"] [data-testid="agent-context-rail"]')
    ).toHaveCount(0)
    await expect(page.getByTestId('workspace-context-toggle')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('w2-agent-open.png') })

    // Back leaves the agent for the Agents list it came from.
    await page.getByTestId('agent-chat-back').click()
    await expect(page.getByTestId('conversations-page')).toHaveAttribute(
      'data-conversation-scope',
      'brainstorming'
    )
    await expectDestination(page, 'agents')
    await expect(
      page.locator(`[data-testid="workspace-agent-row"][data-agent-id="${agentId}"]`)
    ).toBeVisible()
    await expect(page.locator(`${FRAME} header nav [aria-current="page"]`)).not.toHaveText(
      AGENT_NAME
    )

    // ── Threads and Projects: the same surface, a different list ────────────────────────────────
    for (const destination of ['threads', 'projects'] as const) {
      await page.locator(`[data-workspace-nav-item="${destination}"]`).click()
      await expectDestination(page, destination)
      await expect(page.getByTestId('workspace-roster')).toHaveAttribute(
        'data-roster-list',
        destination
      )
      await expectShellUnchanged(destination)
    }

    // ── Backlog: a Workspace destination, its summary in the frame column ───────────────────────
    await page.locator('[data-workspace-nav-item="backlog"]').click()
    await expect.poll(() => activeView(page)).toBe('backlog')
    await expect(page.locator(FRAME)).toHaveAttribute('data-workspace-destination', 'backlog')
    await expect(page.locator('[data-backlog-page]')).toBeVisible()
    await expect(page.locator(`${FRAME_COLUMN} [data-backlog-summary]`)).toBeVisible()
    await expectShellUnchanged('backlog')
    await page.screenshot({ path: testInfo.outputPath('w2-backlog.png') })

    // ── Leave through the frame, re-enter: Resume is still home ─────────────────────────────────
    await page.locator('[data-workspace-nav-item="agents"]').click()
    await expectDestination(page, 'agents')
    await page.getByTestId('workspace-exit').click()
    await expect.poll(() => activeView(page)).not.toMatch(/^(resumeCenter|conversations|backlog)$/)
    await expect(page.locator(FRAME)).toHaveCount(0)
    await expectShellUnchanged('after leaving')
    await page.locator(WORKSPACE_ENTRY).first().click()
    await expect.poll(() => activeView(page)).toBe('resumeCenter')
    await expectDestination(page, 'resume')

    // ── Narrow: the column folds, navigation becomes a strip, Details opens the context ─────────
    await setWindow(app, 900, 800)
    await expect(page.locator(FRAME)).toHaveAttribute('data-workspace-frame-layout', 'strip')
    await expect(page.locator(FRAME_COLUMN)).toHaveCount(0)
    const strip = page.locator('[data-workspace-nav="strip"]')
    await expect(strip).toBeVisible()
    // Folding moves the destinations; it must not drop one.
    await expect(strip.locator('[data-workspace-nav-item]')).toHaveCount(destinationCount)
    await expectShellUnchanged('narrow')
    const details = page.locator('[data-workspace-frame-context-toggle]')
    await expect(details).toHaveAttribute('aria-pressed', 'false')
    await details.click()
    await expect(details).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-workspace-frame-column="overlay"]')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('w2-narrow-details.png') })
    // Navigation stays reachable while folded.
    await strip.locator('[data-workspace-nav-item="agents"]').click()
    await expectDestination(page, 'agents')

    await session.close(app)
  } finally {
    await session.dispose().catch((error: unknown) => {
      console.error(
        `[workspace-navigation-e2e] cleanup failed (not a test result): ${String(error)}`
      )
    })
  }
})
