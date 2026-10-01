import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

// SC1 + SC2 in the real app. Items under test are created ONLY through the rail and the capture
// dialog; `window.__store` is setup (second repo, project ids), `window.api.runtime.call` is the
// ledger ORACLE. Every locator is a data-* handle: the E2E host may render Spanish.
// The page comes from createRestartSession (the real Orca window), never Playwright's `page`.

test.setTimeout(300_000)

// Written out here, not imported: a drift in the shared open-state constant must be caught, not mirrored.
const OPEN_STATES = [
  'needs-triage',
  'ready',
  'waiting-for-executor',
  'preparing',
  'running',
  'review',
  'blocked',
  'stale',
  'unknown'
] as const
const ALL_STATES = [...OPEN_STATES, 'done', 'dismissed', 'superseded'] as const
const KINDS = ['engineering', 'research', 'decision', 'manual', 'idea'] as const

type ListFilter = { projectId?: string; unassigned?: boolean; kind?: string; state?: string }
type LedgerItem = {
  id: string
  originalText: string
  state: string
  projectRefs: { projectId: string }[]
}
type HealthReport = {
  outcome: string
  items: { total: number; byState: Record<string, number> }
  quarantined: unknown[]
}
type Claim = { count: string | null; text: string | null }

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

async function ledgerTotal(page: Page, filter: ListFilter): Promise<number> {
  const result = await rpc<{ outcome: string; total: number }>(page, 'backlog.list', {
    ...filter,
    limit: 1
  })
  if (result.outcome !== 'listed') {
    throw new Error(`backlog.list answered ${result.outcome}`)
  }
  return result.total
}

async function health(page: Page): Promise<HealthReport> {
  const report = await rpc<HealthReport>(page, 'backlog.health')
  if (report.outcome !== 'opened') {
    throw new Error(`backlog.health answered ${report.outcome}`)
  }
  return report
}

async function allItems(page: Page): Promise<LedgerItem[]> {
  const items: LedgerItem[] = []
  let cursor: string | null = null
  do {
    const params: Record<string, unknown> =
      cursor === null ? { limit: 500 } : { limit: 500, cursor }
    const result = await rpc<{ outcome: string; items: LedgerItem[]; nextCursor: string | null }>(
      page,
      'backlog.list',
      params
    )
    if (result.outcome !== 'listed') {
      throw new Error(`backlog.list answered ${result.outcome}`)
    }
    items.push(...result.items)
    cursor = result.nextCursor
  } while (cursor !== null)
  return items
}

async function openProjectIds(page: Page): Promise<Set<string>> {
  const open = new Set<string>(OPEN_STATES)
  const ids = new Set<string>()
  for (const item of await allItems(page)) {
    if (open.has(item.state)) {
      item.projectRefs.forEach((ref) => ids.add(ref.projectId))
    }
  }
  return ids
}

/** The ledger's expectation for every number the page shows, read at rest (Open, no search, all kinds). */
async function ledgerExpectation(page: Page): Promise<Map<string, number>> {
  const memo = new Map<string, number>()
  const openCount = async (filter: ListFilter): Promise<number> => {
    const key = JSON.stringify(filter)
    if (!memo.has(key)) {
      let sum = 0
      for (const state of OPEN_STATES) {
        sum += await ledgerTotal(page, { ...filter, state })
      }
      memo.set(key, sum)
    }
    return memo.get(key)!
  }
  const report = await health(page)
  const openTotal = OPEN_STATES.reduce((sum, state) => sum + (report.items.byState[state] ?? 0), 0)
  // U-2: the header's list-derived total and the ledger's health counts must agree.
  expect(await openCount({})).toBe(openTotal)
  expect(await ledgerTotal(page, {})).toBe(report.items.total)
  expect(report.quarantined).toHaveLength(0)

  const expected = new Map<string, number>()
  expected.set('header:open', openTotal)
  const projects = await openProjectIds(page)
  expected.set('header:projects', projects.size)
  const knownProjects = await page.evaluate(() =>
    window.__store!.getState().projects.map((project) => project.id)
  )
  for (const projectId of projects) {
    const count = await openCount({ projectId })
    const known = knownProjects.includes(projectId)
    expected.set(`group:${known ? 'project' : 'unknown'}:${projectId}`, count)
    expected.set(`scope:project:${projectId}`, count)
  }
  const unassigned = await openCount({ unassigned: true })
  if (unassigned > 0) {
    expected.set('group:unassigned', unassigned)
  }
  expected.set('scope:all', openTotal)
  expected.set('scope:unassigned', unassigned)
  // Every item under test was captured by hand, so the manual source covers the open set.
  expected.set('scope:source:manual', openTotal)
  for (const kind of KINDS) {
    expected.set(`kind:${kind}`, await openCount({ kind }))
  }
  for (const state of ALL_STATES) {
    const count = await ledgerTotal(page, { state })
    expect(count).toBe(report.items.byState[state] ?? 0)
    if (count > 0) {
      expected.set(`state:${state}`, count)
    }
  }
  expected.set('total', report.items.total)
  return expected
}

/** Every rendered number on the page: its data-count and its ClaimValue text. */
async function readRenderedClaims(page: Page): Promise<Record<string, Claim>> {
  return page.evaluate(() => {
    const claims: Record<string, { count: string | null; text: string | null }> = {}
    const add = (key: string, element: Element, claimSelector: string): void => {
      claims[key] = {
        count: element.getAttribute('data-count'),
        text: element.querySelector(claimSelector)?.textContent ?? null
      }
    }
    const single = (selector: string, key: string, claim: string): void => {
      const element = document.querySelector(selector)
      if (element) {
        add(key, element, claim)
      }
    }
    single('[data-backlog-open-total]', 'header:open', '[data-testid="backlog-open-total"]')
    single(
      '[data-backlog-project-total]',
      'header:projects',
      '[data-testid="backlog-project-total"]'
    )
    single('[data-backlog-summary-total]', 'total', '[data-testid="backlog-summary-total"]')
    for (const group of document.querySelectorAll('[data-backlog-group]')) {
      add(
        `group:${group.getAttribute('data-backlog-group')}`,
        group,
        '[data-backlog-group-toggle] [data-testid="backlog-group-count"]'
      )
    }
    for (const chip of document.querySelectorAll('[data-backlog-scope]')) {
      add(
        `scope:${chip.getAttribute('data-backlog-scope')}`,
        chip,
        '[data-testid="backlog-scope-count"]'
      )
    }
    for (const row of document.querySelectorAll('[data-backlog-summary-kind]')) {
      add(
        `kind:${row.getAttribute('data-backlog-summary-kind')}`,
        row,
        '[data-testid="backlog-summary-kind-count"]'
      )
    }
    for (const row of document.querySelectorAll('[data-backlog-summary-state]')) {
      add(
        `state:${row.getAttribute('data-backlog-summary-state')}`,
        row,
        '[data-testid="backlog-summary-state-count"]'
      )
    }
    return claims
  })
}

function claimMismatches(rendered: Record<string, Claim>, expected: Map<string, number>): string[] {
  const problems: string[] = []
  for (const [key, value] of expected) {
    const claim = rendered[key]
    if (!claim) {
      problems.push(`${key}: not rendered (ledger ${value})`)
    } else if (claim.count !== String(value) || claim.text !== String(value)) {
      problems.push(`${key}: data-count ${claim.count} text ${claim.text} (ledger ${value})`)
    }
  }
  for (const key of Object.keys(rendered)) {
    if (!expected.has(key)) {
      problems.push(`${key}: rendered ${rendered[key].count} with no ledger counterpart`)
    }
  }
  return problems
}

/** SC2: every rendered number equals an independent ledger query, as data-count AND as text. */
async function expectCountsEqualLedger(page: Page): Promise<void> {
  const readyPage = page.locator('[data-backlog-page][data-backlog-status="ready"]')
  await expect(readyPage).toBeVisible({ timeout: 30_000 })
  const summary = page.locator('[data-backlog-summary][data-backlog-summary-status="ready"]')
  await expect(summary).toBeVisible({ timeout: 30_000 })
  const expected = await ledgerExpectation(page)
  await expect
    .poll(async () => claimMismatches(await readRenderedClaims(page), expected), {
      timeout: 30_000
    })
    .toEqual([])
  // Absences, each after its station: the summary is present, the page is ready.
  await expect(summary).toBeVisible()
  await expect(page.locator('[data-backlog-summary-quarantined]')).toHaveCount(0)
  await expect(readyPage).toBeVisible()
  await expect(page.locator('[data-backlog-notice="count-mismatch"]')).toHaveCount(0)
}

async function openBacklog(page: Page): Promise<void> {
  // Station control: the rail is on screen before anything inside it is reasoned about.
  await expect(page.locator('[data-workspace-activity="workspace"]')).toBeVisible()
  await page.locator('[data-workspace-activity="backlog"]').first().click()
  await expect(page.locator('[data-backlog-page]')).toBeVisible()
}

type CaptureTarget = { projects: string[] | 'default'; kind?: string }

/** Capture through the dialog; returns the ledger's id for the text. */
async function captureThroughDialog(
  page: Page,
  text: string,
  target: CaptureTarget,
  expectedProjects: string[]
): Promise<string> {
  await page.locator('[data-backlog-page] [data-backlog-action="capture"]').click()
  const dialog = page.locator('[data-backlog-capture-dialog]')
  await expect(dialog).toHaveAttribute('data-backlog-capture-status', 'idle')
  const picker = dialog.locator('[data-backlog-capture-field="project"]')
  if (target.projects !== 'default') {
    const option = (value: string) =>
      page.locator(`[data-backlog-capture-project-option="${value}"]`)
    await picker.click()
    await option('unassigned').click()
    await expect(option('unassigned')).toHaveAttribute('data-backlog-selected', 'true')
    for (const projectId of target.projects) {
      await option(projectId).click()
      await expect(option(projectId)).toHaveAttribute('data-backlog-selected', 'true')
    }
    // One Escape per open layer: this one closes the picker, never the dialog.
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-backlog-project-search]')).toHaveCount(0)
    await expect(dialog).toBeVisible()
  }
  await expect(picker).toHaveAttribute(
    'data-value',
    expectedProjects.length === 0 ? 'unassigned' : expectedProjects.join(',')
  )
  if (target.kind) {
    const kind = dialog.locator('[data-backlog-capture-field="kind"]')
    await kind.click()
    await page.locator(`[role="option"][data-backlog-option="${target.kind}"]`).click()
    await expect(kind).toHaveAttribute('data-value', target.kind)
  }
  await dialog.locator('[data-backlog-capture-field="text"]').fill(text)
  await dialog.locator('[data-backlog-capture-submit]').click()
  await expect(dialog).toHaveAttribute('data-backlog-capture-status', 'confirmed', {
    timeout: 30_000
  })

  const matches = (await allItems(page)).filter((item) => item.originalText === text)
  expect(matches).toHaveLength(1)
  expect(matches[0].projectRefs.map((ref) => ref.projectId).sort()).toEqual(
    [...expectedProjects].sort()
  )

  await dialog.locator('[data-backlog-capture-close]').click()
  await expect(dialog).toHaveCount(0)
  return matches[0].id
}

async function expectInGroups(page: Page, itemId: string, groupKeys: string[]): Promise<void> {
  await expect(page.locator('[data-backlog-page][data-backlog-status="ready"]')).toBeVisible({
    timeout: 30_000
  })
  for (const key of groupKeys) {
    await expect(
      page.locator(`[data-backlog-group="${key}"] [data-backlog-item-id="${itemId}"]`)
    ).toBeVisible({ timeout: 30_000 })
  }
  await expect(page.locator(`[data-backlog-item-id="${itemId}"]`)).toHaveCount(groupKeys.length)
}

async function renderedGroupKeys(page: Page): Promise<string[]> {
  return page
    .locator('[data-backlog-group]')
    .evaluateAll((groups) => groups.map((group) => group.getAttribute('data-backlog-group') ?? ''))
}

async function renderedItemIds(page: Page, groupKey: string): Promise<string[]> {
  return page
    .locator(`[data-backlog-group="${groupKey}"] [data-backlog-item-id]`)
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-backlog-item-id') ?? '').sort())
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

test('capture across projects, restart, find, filter, search and change state; every count equals the ledger', async ({
  testRepoPath
}, testInfo) => {
  const session = createRestartSession(testInfo)
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-backlog-b-'))
  const stamp = Date.now()
  const text = {
    a: `SC1 alpha-only-${stamp}`,
    b: `SC1 bravo-only-${stamp}`,
    unassigned: `SC1 unassigned-only-${stamp}`,
    ab: `SC1 alpha-bravo-${stamp}`
  }
  try {
    // 1. Project A (the seeded repo) and project B (a fresh git repo), A active.
    const first = await session.launch()
    const worktreeA = await attachRepoAndOpenTerminal(first.page, testRepoPath)
    const repoA = await first.page.evaluate(
      (worktreeId) =>
        Object.entries(window.__store!.getState().worktreesByRepo).find(([, worktrees]) =>
          worktrees.some((worktree) => worktree.id === worktreeId)
        )?.[0] ?? null,
      worktreeA
    )
    expect(repoA).toBeTruthy()
    const repoPathB = createGitRepository(tempRoot)
    const repoB = await first.page.evaluate(async (repositoryPath) => {
      const repo = await window.__store!.getState().addRepoPath(repositoryPath)
      if (!repo) {
        throw new Error(`could not add ${repositoryPath}`)
      }
      return repo.id
    }, repoPathB)
    // Setup: the capture dialog defaults from activeRepoId, which worktree activation alone may not set.
    await first.page.evaluate(
      ({ worktreeId, repoId }) => {
        const state = window.__store!.getState()
        state.setActiveWorktree(worktreeId)
        state.setActiveRepo(repoId)
      },
      { worktreeId: worktreeA, repoId: repoA! }
    )
    await expect
      .poll(() => first.page.evaluate(() => window.__store!.getState().activeRepoId))
      .toBe(repoA)
    const projectA = await projectIdForRepo(first.page, repoA!)
    const projectB = await projectIdForRepo(first.page, repoB)
    expect(projectA).not.toBe(projectB)

    await openBacklog(first.page)

    // 2. Four captures through the dialog; each confirmed one is sampled in the ledger and the DOM.
    const ids = {
      a: await captureThroughDialog(
        first.page,
        text.a,
        { projects: 'default', kind: 'engineering' },
        [projectA]
      ),
      b: '',
      unassigned: '',
      ab: ''
    }
    await expectInGroups(first.page, ids.a, [`project:${projectA}`])
    ids.b = await captureThroughDialog(first.page, text.b, { projects: [projectB] }, [projectB])
    await expectInGroups(first.page, ids.b, [`project:${projectB}`])
    ids.unassigned = await captureThroughDialog(first.page, text.unassigned, { projects: [] }, [])
    await expectInGroups(first.page, ids.unassigned, ['unassigned'])
    ids.ab = await captureThroughDialog(first.page, text.ab, { projects: [projectA, projectB] }, [
      projectA,
      projectB
    ])
    await expectInGroups(first.page, ids.ab, [`project:${projectA}`, `project:${projectB}`])

    // 3. Restart: a new process on the same profile.
    await session.close(first.app)
    const second = await session.launch()
    const page = second.page
    await attachRepoAndOpenTerminal(page, testRepoPath)
    expect(await projectIdForRepo(page, repoA!)).toBe(projectA)
    expect(await projectIdForRepo(page, repoB)).toBe(projectB)
    await openBacklog(page)
    await expect(page.locator('[data-backlog-page][data-backlog-status="ready"]')).toBeVisible({
      timeout: 30_000
    })

    // 4. Identity, not count: each id in exactly its groups, Unassigned last.
    await expectInGroups(page, ids.a, [`project:${projectA}`])
    await expectInGroups(page, ids.b, [`project:${projectB}`])
    await expectInGroups(page, ids.unassigned, ['unassigned'])
    await expectInGroups(page, ids.ab, [`project:${projectA}`, `project:${projectB}`])
    for (const groupKey of [`project:${projectA}`, `project:${projectB}`]) {
      await expect(
        page.locator(`[data-backlog-group="${groupKey}"] [data-backlog-item-id="${ids.ab}"]`)
      ).toHaveAttribute('data-backlog-cross-project', 'true')
    }
    expect((await renderedGroupKeys(page)).at(-1)).toBe('unassigned')

    // 5. SC2 before the state change.
    await expectCountsEqualLedger(page)

    // 6. Filter by project B, then by Unassigned, then back to All.
    await page.locator(`[data-backlog-scope="project:${projectB}"]`).click()
    await expect.poll(() => renderedGroupKeys(page)).toEqual([`project:${projectB}`])
    expect(await renderedItemIds(page, `project:${projectB}`)).toEqual([ids.b, ids.ab].sort())
    await page.locator('[data-backlog-scope="unassigned"]').click()
    await expect.poll(() => renderedGroupKeys(page)).toEqual(['unassigned'])
    expect(await renderedItemIds(page, 'unassigned')).toEqual([ids.unassigned])
    await page.locator('[data-backlog-scope="all"]').click()
    await expect.poll(() => renderedGroupKeys(page)).toContain(`project:${projectA}`)

    // 7. Search a unique token.
    const search = page.locator('[data-backlog-search]')
    await search.fill(`bravo-only-${stamp}`)
    await expect(page.locator('[data-backlog-item-id]')).toHaveCount(1)
    await expect(page.locator(`[data-backlog-item-id="${ids.b}"]`)).toBeVisible()
    await search.fill('')
    await expect(page.locator(`[data-backlog-item-id="${ids.a}"]`)).toBeVisible()

    // 8. Dismiss A-only from its row; it leaves the Open view once the ledger confirmed it.
    const groupA = page.locator(`[data-backlog-group="project:${projectA}"]`)
    const rowA = groupA.locator(`[data-backlog-item-id="${ids.a}"]`)
    await rowA.locator('[data-backlog-row-toggle]').click()
    const detail = rowA.locator('[data-backlog-item-detail]')
    await expect(detail).toHaveAttribute('data-backlog-detail-status', 'loaded', {
      timeout: 30_000
    })
    await detail.locator('[data-backlog-action="change-state"]').click()
    await page.locator('[data-backlog-transition="dismissed"]').click()
    // Station: A's group is still rendered (it holds the cross-project item) when A-only is gone.
    await expect(groupA.locator(`[data-backlog-item-id="${ids.ab}"]`)).toBeVisible()
    await expect(page.locator(`[data-backlog-item-id="${ids.a}"]`)).toHaveCount(0, {
      timeout: 30_000
    })
    const record = await rpc<{ outcome: string; record: { state: string } }>(page, 'backlog.get', {
      id: ids.a
    })
    expect(record.outcome).toBe('loaded')
    expect(record.record.state).toBe('dismissed')

    // 9. SC2 after the state change: the open total and A's group each moved by one.
    await expectCountsEqualLedger(page)
    await expect(page.locator('[data-backlog-open-total]')).toHaveAttribute('data-count', '3')
    await expect(groupA).toHaveAttribute('data-count', '1')

    // 10. All states brings the dismissed row back, carrying its ledger state.
    await page.locator('[data-backlog-filter="state"]').click()
    await page.locator('[role="option"][data-backlog-option="all"]').click()
    await expect(page.locator('[data-backlog-filter="state"]')).toHaveAttribute('data-value', 'all')
    await expect(rowA).toBeVisible()
    await expect(rowA).toHaveAttribute('data-backlog-state', 'dismissed')

    await session.close(second.app)
  } finally {
    // Cleanup never decides the verdict.
    await session.dispose().catch((error: unknown) => {
      console.error(`[backlog-e2e] cleanup failed (not a test result): ${String(error)}`)
    })
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch (error) {
      console.error(`[backlog-e2e] left ${tempRoot}: ${String(error)}`)
    }
  }
})

function findLedgerItemsDirectory(userDataDir: string): string {
  const root = path.resolve(userDataDir)
  // T-02-24: only this session's own temp profile may be touched.
  if (
    !path.basename(root).startsWith('orca-e2e-restart-') ||
    !root.startsWith(path.resolve(os.tmpdir()) + path.sep)
  ) {
    throw new Error(`refusing to touch a ledger outside an e2e temp profile: ${root}`)
  }
  const profiles = path.join(root, 'profiles')
  const found = existsSync(profiles)
    ? readdirSync(profiles)
        .map((profileId) => path.join(profiles, profileId, 'backlog', 'items'))
        .filter((candidate) => existsSync(candidate))
    : []
  if (found.length !== 1) {
    throw new Error(`expected one backlog/items directory under ${profiles}, found ${found.length}`)
  }
  const itemsDir = path.resolve(found[0])
  if (!itemsDir.startsWith(root + path.sep)) {
    throw new Error(`refusing to touch ${itemsDir}: not inside ${root}`)
  }
  return itemsDir
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      // Why: on Windows a just-closed Electron can hold the directory handle for a moment.
      if (attempt === 9) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
}

test('a ledger that cannot be read shows storage-failed, never empty', async ({
  testRepoPath
}, testInfo) => {
  const session = createRestartSession(testInfo)
  try {
    const first = await session.launch()
    await attachRepoAndOpenTerminal(first.page, testRepoPath)
    await openBacklog(first.page)
    await captureThroughDialog(
      first.page,
      `SC1 unreadable-ledger-${Date.now()}`,
      { projects: [] },
      []
    )
    await session.close(first.app)

    // A real ENOTDIR on the next scan: the items directory becomes a regular file.
    const itemsDir = findLedgerItemsDirectory(session.userDataDir)
    await renameWithRetry(itemsDir, `${itemsDir}-moved`)
    writeFileSync(itemsDir, 'not a directory\n')

    const second = await session.launch()
    const page = second.page
    await attachRepoAndOpenTerminal(page, testRepoPath)
    await openBacklog(page)
    const backlogPage = page.locator('[data-backlog-page]')
    await expect(backlogPage).toHaveAttribute('data-backlog-status', 'storage-failed', {
      timeout: 30_000
    })
    await expect(backlogPage).toHaveAttribute('data-backlog-failure-stage', 'scan')
    testInfo.annotations.push({
      type: 'failure-code',
      description: String(await backlogPage.getAttribute('data-backlog-failure-code'))
    })
    await expect(page.locator('[data-backlog-item-id]')).toHaveCount(0)

    await backlogPage.locator('[data-backlog-action="retry"]').click()
    await page.waitForTimeout(1_000)
    await expect(backlogPage).toHaveAttribute('data-backlog-status', 'storage-failed')
    await expect(page.locator('[data-backlog-item-id]')).toHaveCount(0)

    await session.close(second.app)
  } finally {
    await session.dispose().catch((error: unknown) => {
      console.error(`[backlog-e2e] cleanup failed (not a test result): ${String(error)}`)
    })
  }
})
