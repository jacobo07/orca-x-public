import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Locator, Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

// SC3 evidence (D-24) and the two UI-SPEC overflow backstops, in the real Electron app. The ledger
// is SEEDED here through backlog.capture / backlog.transition: setup, not the thing under test
// (capture itself is proven in backlog-capture-restart.spec.ts). Screenshots are dark, taken only
// after the dark class is asserted and every finite document animation has finished.

test.setTimeout(300_000)

type Seed = { text: string; kind: string; priority?: string; projectIds: string[]; to?: string[] }

async function rpc<T>(page: Page, method: string, params?: unknown): Promise<T> {
  return (await page.evaluate(
    async ({ method, params }) => {
      const response = await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(`${method} failed: ${response.error.code}`)
      }
      return response.result
    },
    { method, params }
  )) as T
}

async function seedLedger(page: Page, seeds: Seed[]): Promise<void> {
  const failures = await page.evaluate(async (seeds) => {
    const problems: string[] = []
    for (const seed of seeds) {
      const captured = await window.api.runtime.call({
        method: 'backlog.capture',
        params: {
          text: seed.text,
          kind: seed.kind,
          ...(seed.priority ? { priority: seed.priority } : {}),
          ...(seed.projectIds.length > 0
            ? {
                projectRefs: seed.projectIds.map((projectId) => ({
                  projectId,
                  mapping: 'explicit',
                  evidence: ''
                }))
              }
            : {})
        }
      })
      const result = captured.ok
        ? (captured.result as { outcome: string; record?: { id: string } })
        : null
      if (!result || result.outcome !== 'published' || !result.record) {
        problems.push(`capture ${seed.text}: ${result?.outcome ?? 'rpc error'}`)
        continue
      }
      for (const to of seed.to ?? []) {
        const moved = await window.api.runtime.call({
          method: 'backlog.transition',
          params: { id: result.record.id, to }
        })
        const outcome = moved.ok ? (moved.result as { outcome: string }).outcome : 'rpc error'
        if (outcome !== 'published') {
          problems.push(`transition ${seed.text} -> ${to}: ${outcome}`)
        }
      }
    }
    return problems
  }, seeds)
  expect(failures).toEqual([])
}

/** Wait until every finite document animation has finished, then two frames. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((animation) => {
      const end = animation.effect?.getComputedTiming().endTime
      return typeof end === 'number' && Number.isFinite(end)
    })
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}

async function resizeWindow(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number
): Promise<[number, number]> {
  const before = await page.evaluate(() => window.innerWidth)
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height)
    },
    { width, height }
  )
  if (Math.abs(before - width) > 40) {
    await expect.poll(() => page.evaluate(() => window.innerWidth)).not.toBe(before)
  }
  await settle(page)
  return page.evaluate(() => [window.innerWidth, window.innerHeight] as [number, number])
}

async function setDarkTheme(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__store!.getState().updateSettingsOrThrow({ theme: 'dark' })
  })
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(true)
}

async function shoot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  // The theme is asserted at every shot, never assumed from an earlier one.
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true)
  await settle(page)
  await page.screenshot({ path: testInfo.outputPath(name) })
}

/**
 * CSS px of the subject actually on screen: its box clipped by every clipping ancestor and the
 * window. A layout can keep rows "visible" to Playwright while a clipping parent has 0px height.
 * `parent` measures the element's parent; `scroll` first scrolls the subject into view.
 */
async function onScreenHeight(
  locator: Locator,
  options: { parent?: boolean; scroll?: boolean } = {}
): Promise<number> {
  return locator.evaluate((element, { parent, scroll }) => {
    const subject = parent ? element.parentElement! : element
    if (scroll) {
      subject.scrollIntoView({ block: 'start' })
    }
    const box = subject.getBoundingClientRect()
    let top = Math.max(box.top, 0)
    let bottom = Math.min(box.bottom, window.innerHeight)
    for (let node = subject.parentElement; node; node = node.parentElement) {
      if (getComputedStyle(node).overflowY !== 'visible') {
        const clip = node.getBoundingClientRect()
        top = Math.max(top, clip.top)
        bottom = Math.min(bottom, clip.bottom)
      }
    }
    return Math.max(0, bottom - top)
  }, options)
}

/**
 * On-screen height of the group list (the parent of every group card) once scrolled to: a list
 * reachable by scrolling the page passes, a list clipped by a 0px parent cannot.
 */
async function visibleListHeight(page: Page): Promise<number> {
  return onScreenHeight(page.locator('[data-backlog-group]').first(), {
    parent: true,
    scroll: true
  })
}

async function openBacklog(page: Page): Promise<number> {
  await expect(page.locator('[data-workspace-activity="workspace"]')).toBeVisible()
  const started = Date.now()
  await page.locator('[data-workspace-activity="backlog"]').first().click()
  await expect(page.locator('[data-backlog-page][data-backlog-status="ready"]')).toBeVisible({
    timeout: 60_000
  })
  return Date.now() - started
}

function createGitRepository(parent: string): string {
  const repositoryPath = path.join(parent, 'backlog-project-b')
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: repositoryPath, stdio: 'pipe' })
  }
  execFileSync('git', ['init', repositoryPath], { stdio: 'pipe' })
  git(['config', 'user.email', 'e2e@test.local'])
  git(['config', 'user.name', 'E2E Test'])
  writeFileSync(path.join(repositoryPath, 'README.md'), '# Backlog project B\n')
  git(['add', '-A'])
  git(['commit', '-m', 'Initial commit'])
  return repositoryPath
}

async function projectIdForRepo(page: Page, repoId: string): Promise<string> {
  let projectId: string | null = null
  await expect
    .poll(
      async () => {
        projectId = await page.evaluate(async (repoId) => {
          const store = window.__store!
          await store.getState().fetchRepos()
          return (
            store.getState().projects.find((project) => project.sourceRepoIds.includes(repoId))
              ?.id ?? null
          )
        }, repoId)
        return projectId
      },
      { timeout: 30_000, message: `no Project owns repo ${repoId}` }
    )
    .not.toBeNull()
  return projectId!
}

test('north-star screenshots', async ({ testRepoPath }, testInfo) => {
  const session = createRestartSession(testInfo)
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-backlog-screens-'))
  try {
    const { app, page } = await session.launch()
    const worktreeA = await attachRepoAndOpenTerminal(page, testRepoPath)
    const repoA = await page.evaluate(
      (worktreeId) =>
        Object.entries(window.__store!.getState().worktreesByRepo).find(([, worktrees]) =>
          worktrees.some((worktree) => worktree.id === worktreeId)
        )?.[0] ?? null,
      worktreeA
    )
    expect(repoA).toBeTruthy()
    const repoB = await page.evaluate(async (repositoryPath) => {
      const repo = await window.__store!.getState().addRepoPath(repositoryPath)
      if (!repo) {
        throw new Error(`could not add ${repositoryPath}`)
      }
      return repo.id
    }, createGitRepository(tempRoot))
    await page.evaluate(
      ({ worktreeId, repoId }) => {
        const state = window.__store!.getState()
        state.setActiveWorktree(worktreeId)
        state.setActiveRepo(repoId)
      },
      { worktreeId: worktreeA, repoId: repoA! }
    )
    const a = await projectIdForRepo(page, repoA!)
    const b = await projectIdForRepo(page, repoB)

    await seedLedger(page, [
      {
        text: 'Split the ledger scan into pages',
        kind: 'engineering',
        priority: 'high',
        projectIds: [a]
      },
      {
        text: 'Decide the retention window for dismissed items',
        kind: 'decision',
        projectIds: [a],
        to: ['ready']
      },
      {
        text: 'Profile the row expand on 300 items\nMeasure before optimizing',
        kind: 'research',
        projectIds: [a]
      },
      {
        text: 'Document the capture shortcut',
        kind: 'manual',
        priority: 'low',
        projectIds: [a],
        to: ['dismissed']
      },
      { text: 'Onboarding checklist for the second repo', kind: 'manual', projectIds: [b] },
      {
        text: 'Retry policy for the importer',
        kind: 'engineering',
        priority: 'urgent',
        projectIds: [b],
        to: ['blocked']
      },
      { text: 'Compare transcript formats', kind: 'research', projectIds: [b], to: ['ready'] },
      { text: 'Shared release notes for both projects', kind: 'decision', projectIds: [a, b] },
      { text: 'Align the badge colours across projects', kind: 'idea', projectIds: [a, b] },
      { text: 'Voice capture from the dock', kind: 'idea', projectIds: [] },
      { text: 'Read the North Star once more', kind: 'manual', priority: 'high', projectIds: [] },
      { text: 'A weekly digest of stale items', kind: 'idea', projectIds: [], to: ['blocked'] }
    ])

    await setDarkTheme(page)
    const wide = await resizeWindow(app, page, 1700, 960)
    await openBacklog(page)
    await expect(
      page.locator('[data-backlog-summary][data-backlog-summary-status="ready"]')
    ).toBeVisible()
    await shoot(page, testInfo, 'backlog-dark-wide.png')

    const groupA = page.locator(`[data-backlog-group="project:${a}"]`)
    const row = groupA.locator('[data-backlog-item-id]').first()
    await row.locator('[data-backlog-row-toggle]').click()
    await expect(row.locator('[data-backlog-item-detail]')).toHaveAttribute(
      'data-backlog-detail-status',
      'loaded'
    )
    await shoot(page, testInfo, 'backlog-dark-wide-expanded.png')

    await page.locator('[data-backlog-page] [data-backlog-action="capture"]').click()
    const dialog = page.locator('[data-backlog-capture-dialog]')
    await expect(dialog).toHaveAttribute('data-backlog-capture-status', 'idle')
    await shoot(page, testInfo, 'backlog-dark-wide-capture.png')
    // One Escape for the one open layer; the page (station) stays.
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-backlog-page]')).toBeVisible()
    await expect(dialog).toHaveCount(0)

    const narrow = await resizeWindow(app, page, 900, 900)
    await shoot(page, testInfo, 'backlog-dark-narrow.png')
    // Narrow backstops: the list keeps real height beside the stacked summary, and a row's
    // title keeps a readable width instead of yielding it all to the chip cluster.
    expect(await visibleListHeight(page)).toBeGreaterThanOrEqual(200)
    const titleWidth = (await row.locator('[data-backlog-row-toggle] [title]').boundingBox())!.width
    expect(titleWidth).toBeGreaterThanOrEqual(150)

    testInfo.annotations.push({
      type: 'inner-size',
      description: `wide ${wide.join('x')}, narrow ${narrow.join('x')}`
    })
    console.log(`[backlog-screens] inner size wide ${wide.join('x')} narrow ${narrow.join('x')}`)
    await session.close(app)
  } finally {
    await session.dispose().catch((error: unknown) => {
      console.error(`[backlog-screens] cleanup failed (not a test result): ${String(error)}`)
    })
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch (error) {
      console.error(`[backlog-screens] left ${tempRoot}: ${String(error)}`)
    }
  }
})

test('overflow backstops', async ({ testRepoPath }, testInfo) => {
  const session = createRestartSession(testInfo)
  try {
    const { app, page } = await session.launch()
    await attachRepoAndOpenTerminal(page, testRepoPath)
    // Twelve project ids no Project owns, plus Unassigned: 300 items in 13 groups.
    const stamp = Date.now()
    const ghostProjects = Array.from(
      { length: 12 },
      (_, index) => `ghost-project-${String(index + 1).padStart(2, '0')}`
    )
    const kinds = ['engineering', 'research', 'decision', 'manual', 'idea']
    const seeds: Seed[] = Array.from({ length: 300 }, (_, index) => ({
      text: `Overflow item ${index} token-${stamp}-${index}`,
      kind: kinds[index % kinds.length],
      projectIds: index % 13 === 12 ? [] : [ghostProjects[index % 13]]
    }))
    await seedLedger(page, seeds)

    await setDarkTheme(page)
    const wide = await resizeWindow(app, page, 1700, 960)
    const readyMs = await openBacklog(page)

    const strip = page.locator('[data-backlog-scope="all"]').locator('xpath=..')
    const chipHeight = (await page.locator('[data-backlog-scope="all"]').boundingBox())!.height
    expect((await strip.boundingBox())!.height).toBeGreaterThan(2 * chipHeight)
    await expect(page.locator('[data-backlog-scope]')).toHaveCount(15)
    await shoot(page, testInfo, 'backlog-overflow-wide.png')

    const narrow = await resizeWindow(app, page, 900, 900)
    const narrowChipHeight = (await page.locator('[data-backlog-scope="all"]').boundingBox())!
      .height
    expect((await strip.boundingBox())!.height).toBeGreaterThan(2 * narrowChipHeight)
    await shoot(page, testInfo, 'backlog-overflow-narrow.png')
    // Fifteen wrapped chips and the stacked summary must still leave the list real height.
    expect(await visibleListHeight(page)).toBeGreaterThanOrEqual(200)

    const unassigned = page.locator('[data-backlog-group="unassigned"]')
    // Geometry, not toBeInViewport (it read ratio 0 in the headless e2e window). Off screen before
    // the scroll, at least one row height (48px) on screen after it.
    expect(await onScreenHeight(unassigned)).toBeLessThan(48)
    expect(await onScreenHeight(unassigned, { scroll: true })).toBeGreaterThanOrEqual(48)
    await expect(page.locator('[data-backlog-group]').last()).toHaveAttribute(
      'data-backlog-group',
      'unassigned'
    )
    await expect(unassigned).toHaveAttribute('data-count', '23')

    const token = `token-${stamp}-217`
    const target = (
      await rpc<{ items: { id: string; originalText: string }[] }>(page, 'backlog.list', {
        limit: 500
      })
    ).items.filter((item) => item.originalText.endsWith(token))
    expect(target).toHaveLength(1)
    await page.locator('[data-backlog-search]').fill(token)
    await expect(page.locator('[data-backlog-item-id]')).toHaveCount(1)
    await expect(page.locator(`[data-backlog-item-id="${target[0].id}"]`)).toBeVisible()

    // Observation only: a starved host makes time a noisy instrument; nothing gates on it.
    testInfo.annotations.push({ type: 'rail-to-ready-ms', description: String(readyMs) })
    console.log(
      `[backlog-screens] 300 items: rail click to ready ${readyMs} ms; inner size wide ${wide.join('x')} narrow ${narrow.join('x')}`
    )
    await session.close(app)
  } finally {
    await session.dispose().catch((error: unknown) => {
      console.error(`[backlog-screens] cleanup failed (not a test result): ${String(error)}`)
    })
  }
})
