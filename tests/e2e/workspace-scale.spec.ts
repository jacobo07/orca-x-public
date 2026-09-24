import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// SCALE — remembered agents and threads must stay cheap. Seeds 200 durable agents and 1,000 durable
// threads through the product's own APIs, then opens Workspace and MEASURES: time until the roster is
// drawn, DOM size, rows actually mounted, and renderer heap. The numbers are printed for the record
// and held to a stated budget; the budget is a ceiling for regressions, not a target.

const AGENTS = 200
const THREADS = 1000
const BUDGET = { rosterMs: 5000, domNodes: 25_000, heapMb: 400 }

test('Workspace stays cheap with 200 agents and 1,000 threads', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(600_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  const seeded = await orcaPage.evaluate(
    async ({ agents, threads }) => {
      const project = (await window.api.projects.list())[0]
      const ids: string[] = []
      for (let i = 0; i < agents; i++) {
        const created = (await window.api.agents.create({
          name: `Scale ${i}`,
          role: 'load',
          projectId: project?.id ?? null
        })) as { outcome: string; agent?: { id: string } }
        if (created.agent) {
          ids.push(created.agent.id)
        }
      }
      let conversations = 0
      for (let i = 0; i < threads; i++) {
        const made = (await window.api.conversations.createForAgent({
          agentId: ids[i % ids.length]!,
          title: `Thread ${i}`
        })) as { outcome: string }
        if (made.outcome === 'created') {
          conversations++
        }
      }
      return { agents: ids.length, conversations }
    },
    { agents: AGENTS, threads: THREADS }
  )
  expect(seeded).toEqual({ agents: AGENTS, conversations: THREADS })

  await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setSize(1700, 960)
  )
  // Attribution: the two reads the page makes on open, timed alone, so rosterMs splits into data vs render.
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

  const started = Date.now()
  await orcaPage.locator('[data-workspace-activity="agent-workspace"]').first().click()
  await orcaPage.getByTestId('workspace-tab-agents').click()
  await expect(orcaPage.getByTestId('workspace-agent-row').first()).toBeVisible({ timeout: 60_000 })
  const rosterMs = Date.now() - started

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

  console.log(
    `[workspace-scale] agents=${AGENTS} threads=${THREADS} rosterMs=${rosterMs} agentRows=${agentRows} threadRows=${threadRows} listMs=${reads.listMs} agentsMs=${reads.agentsMs} domNodes=${domNodes} heapMb=${heapMb}`
  )
  expect(reads).toMatchObject({ threads: THREADS, agents: AGENTS })
  expect(rosterMs).toBeLessThan(BUDGET.rosterMs)
  expect(domNodes).toBeLessThan(BUDGET.domNodes)
  expect(heapMb).toBeGreaterThan(0)
  expect(heapMb).toBeLessThan(BUDGET.heapMb)
})
