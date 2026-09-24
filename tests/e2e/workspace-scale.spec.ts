import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// SCALE — remembered agents and threads must stay cheap. Seeds 200 durable agents and 1,000 durable
// threads through the product's own APIs, then opens Workspace and MEASURES: time until the roster is
// drawn, DOM size, rows actually mounted, and renderer heap. The numbers are printed for the record
// and held to a stated budget; the budget is a ceiling for regressions, not a target.
//
// Attribution: the same open path is timed with ONE agent first (cold, then warm), and the page's two
// data reads are timed alone, so the scale figure splits into fixed cost, data and per-row cost.

const AGENTS = 200
const THREADS = 1000
// scaleDeltaMs: what 199 more agents and 1,000 threads may add to the one-agent open. The fixed open cost
// is measured and printed but not budgeted here: it does not move with scale.
const BUDGET = { scaleDeltaMs: 1000, domNodes: 25_000, heapMb: 400 }

async function createAgents(page: Page, from: number, to: number): Promise<string[]> {
  return page.evaluate(
    async ({ from, to }) => {
      const project = (await window.api.projects.list())[0]
      const ids: string[] = []
      for (let i = from; i < to; i++) {
        const created = (await window.api.agents.create({
          name: `Scale ${i}`,
          role: 'load',
          projectId: project?.id ?? null
        })) as { outcome: string; agent?: { id: string } }
        if (created.agent) {
          ids.push(created.agent.id)
        }
      }
      return ids
    },
    { from, to }
  )
}

/** Opens Workspace → Agents from the Terminals view; ms to the entry's tab bar, then to the first row. */
async function openRoster(page: Page): Promise<{ total: number; entry: number; rows: number }> {
  await page.locator('[data-workspace-activity="workspace"]').first().click()
  await expect(page.getByTestId('workspace-agent-row')).toHaveCount(0)
  const started = Date.now()
  await page.locator('[data-workspace-activity="agent-workspace"]').first().click()
  await expect(page.getByTestId('workspace-tab-agents')).toBeVisible({ timeout: 60_000 })
  const entered = Date.now()
  await page.getByTestId('workspace-tab-agents').click()
  await expect(page.getByTestId('workspace-agent-row').first()).toBeVisible({ timeout: 60_000 })
  const done = Date.now()
  return { total: done - started, entry: entered - started, rows: done - entered }
}

test('Workspace stays cheap with 200 agents and 1,000 threads', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(600_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setSize(1700, 960)
  )

  const ids = await createAgents(orcaPage, 0, 1)
  const coldOne = await openRoster(orcaPage)
  const warmOne = await openRoster(orcaPage)

  ids.push(...(await createAgents(orcaPage, 1, AGENTS)))
  const conversations = await orcaPage.evaluate(
    async ({ agentIds, threads }) => {
      let made = 0
      for (let i = 0; i < threads; i++) {
        const result = (await window.api.conversations.createForAgent({
          agentId: agentIds[i % agentIds.length]!,
          title: `Thread ${i}`
        })) as { outcome: string }
        if (result.outcome === 'created') {
          made++
        }
      }
      return made
    },
    { agentIds: ids, threads: THREADS }
  )
  expect({ agents: ids.length, conversations }).toEqual({ agents: AGENTS, conversations: THREADS })

  const reads = await orcaPage.evaluate(async () => {
    const t0 = performance.now()
    const threads = await window.api.conversations.list()
    const t1 = performance.now()
    const agents = await window.api.agents.list()
    const t2 = performance.now()
    return {
      listMs: Math.round(t1 - t0),
      agentsMs: Math.round(t2 - t1),
      threads: threads.length,
      agents: agents.length
    }
  })

  const roster = await openRoster(orcaPage)
  const agentRows = await orcaPage.getByTestId('workspace-agent-row').count()
  await orcaPage.getByTestId('workspace-tab-threads').click()
  await expect(orcaPage.getByTestId('conversations-list-row').first()).toBeVisible({
    timeout: 60_000
  })
  const threadRows = await orcaPage.getByTestId('conversations-list-row').count()
  const domNodes = await orcaPage.evaluate(() => document.querySelectorAll('*').length)
  const heapMb = await orcaPage.evaluate(() => {
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    return memory ? Math.round(memory.usedJSHeapSize / 1_048_576) : -1
  })

  const scaleDeltaMs = roster.total - warmOne.total
  console.log(
    `[workspace-scale] agents=${AGENTS} threads=${THREADS} coldOne=${coldOne.entry}+${coldOne.rows} warmOne=${warmOne.entry}+${warmOne.rows} roster=${roster.entry}+${roster.rows} scaleDeltaMs=${scaleDeltaMs} agentRows=${agentRows} threadRows=${threadRows} listMs=${reads.listMs} agentsMs=${reads.agentsMs} domNodes=${domNodes} heapMb=${heapMb}`
  )
  expect(reads).toMatchObject({ threads: THREADS, agents: AGENTS })
  expect(scaleDeltaMs).toBeLessThan(BUDGET.scaleDeltaMs)
  expect(domNodes).toBeLessThan(BUDGET.domNodes)
  expect(heapMb).toBeGreaterThan(0)
  expect(heapMb).toBeLessThan(BUDGET.heapMb)
})
