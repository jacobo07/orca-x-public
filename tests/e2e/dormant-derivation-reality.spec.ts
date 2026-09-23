/*
 * W3 PRODUCT REALITY — does the derivation shrink survive the trip into Electron?
 *
 * `components/terminal-rail/terminal-rail-derivation-fanout.test.tsx` measured it in happy-dom, with
 * `vi.mock` around `lib/tab-agent` and a hand-built store: 6 resolver calls and 4 pane-key strings
 * per dormant row per unrelated write before `lib/tab-agent-projection.ts`, zero after. That is a
 * structural result about a composed fixture. It is not a claim about the product, because the
 * mechanism depends on the real thing: zustand's listener set, the real store's slice identities,
 * and which presentation surface is actually mounted.
 *
 * So this drives the real app. Rows are seeded the way a user gets them — two real terminals
 * captured through the real producer, cloned to scale, restored into an emptied workspace — and the
 * counters read are the projection's own (`readTabAgentProjectionCounters`), because a packaged
 * renderer cannot be mocked. `lib/tab-agent-projection-counters.test.ts` proves those counters move
 * before this file is allowed to read a zero out of them.
 *
 * BOTH SURFACES, SEPARATELY. W1 measured that the rail and the tab strip are mutually exclusive and
 * swap (`dormant-presentation-attribution.spec.ts`): rail expanded, the strip renders 0 terminal
 * tabs; rail collapsed, the strip renders all of them. There is no state in which neither is
 * mounted, so "dormant rows are presented" is unconditional and the only real question is which
 * surface is paying. Measuring one and calling it the product would answer for half of it.
 *
 * THE ZERO IS ONLY MEANINGFUL BESIDE THE NON-ZERO. A projection that had stopped deriving anything,
 * a rail that had quietly unmounted, and an exposure that failed to bind all report zero on the
 * unrelated write. Each station therefore drives a write the projection genuinely depends on, in
 * the same regime, against the same counters, and requires it to cost the full per-row derivation.
 *
 * Counts, not timings. This host runs near 18% free RAM with two dozen concurrent agent processes,
 * where a wall-clock reading drifts further than anything this change could produce.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { cloneWorkingSetToScale } from '../../src/shared/project-working-set-scale-clone'
import { readProjectWorkingSetManifest } from '../../src/shared/project-working-set-schema'
import { waitForActiveTerminalManager, waitForPaneCount } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

type ProjectionCounters = {
  generations: number
  derivations: number
  paneKeys: number
  reusedReferences: number
  cacheHits: number
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __workingSetE2E?: {
      save: (request: { ownerKey: string; label?: string | null }) => Promise<unknown>
      restore: (request: {
        scope: { executionHostId: 'local'; ownerKey: string }
        workingSetId: string
      }) => Promise<unknown>
    }
    __tabAgentProjectionE2E?: {
      read: () => Promise<ProjectionCounters>
      reset: () => Promise<void>
    }
  }
}

/** Two points, so a per-row slope exists and a fixed per-write cost cannot hide in an intercept. */
const SCALES = [10, 50] as const

type Surface = { name: 'rail' | 'strip'; railCollapsed: boolean }
const SURFACES: readonly Surface[] = [
  { name: 'rail', railCollapsed: false },
  { name: 'strip', railCollapsed: true }
]

type Station = {
  scale: number
  surface: Surface['name']
  /** Rows the surface under test is actually holding. A low count here voids everything below. */
  mounted: number
  unrelated: ProjectionCounters
  relevant: ProjectionCounters
}

function findArtifactDir(root: string, workingSetId: string): string {
  const wanted = `${workingSetId}.json`
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        stack.push(full)
      } else if (name === wanted) {
        return dir
      }
    }
  }
  throw new Error(`no working-set artifact named ${wanted} under ${root}`)
}

async function emptyWorkspace(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((wt) => {
    const s = window.__store!.getState()
    for (const tab of s.tabsByWorktree[wt] ?? []) {
      s.closeTab(tab.id)
    }
  }, worktreeId)
  await expect
    .poll(
      () =>
        page.evaluate((wt) => {
          const s = window.__store!.getState()
          return (s.tabsByWorktree[wt]?.length ?? 0) + (s.unifiedTabsByWorktree[wt]?.length ?? 0)
        }, worktreeId),
      { timeout: 30_000, message: 'workspace did not empty' }
    )
    .toBe(0)
}

/** Steady state is the product's own quiescence, not a fixed sleep: the host list stops moving. */
async function settle(page: Page): Promise<void> {
  let previous: string[] = []
  let stable = 0
  for (let attempt = 0; attempt < 40 && stable < 3; attempt++) {
    await page.waitForTimeout(250)
    const current = await page.evaluate(async () =>
      (await window.api.pty.listSessions()).map((session) => session.id).sort()
    )
    stable = JSON.stringify(current) === JSON.stringify(previous) ? stable + 1 : 0
    previous = current
  }
  expect(stable, 'host session list never quiesced').toBeGreaterThanOrEqual(3)
}

/**
 * Apply a store write and let the renderer finish reacting to it before reading the counters.
 *
 * Two frames, not a timeout: zustand notifies synchronously but React commits on the next paint, and
 * a count taken between the two would credit the projection for work that had not happened yet.
 */
async function writeAndSettle(page: Page, write: 'unrelated' | 'relevant'): Promise<void> {
  await page.evaluate(async (kind) => {
    const store = window.__store!
    if (kind === 'unrelated') {
      // A write about the side panel says nothing about any terminal: it touches none of the ten
      // store references the projection reads.
      store.setState({ rightSidebarOpen: !store.getState().rightSidebarOpen })
    } else {
      // A new reference for a slice the projection DOES read, content-equal on purpose: the
      // derivation must re-run, while structural sharing still spares every row a re-render.
      store.setState({ agentStatusByPaneKey: { ...store.getState().agentStatusByPaneKey } })
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  }, write)
}

const countRows = (page: Page, surface: Surface['name']): Promise<number> =>
  page.evaluate(
    (name) =>
      document.querySelectorAll(
        name === 'rail' ? '[data-terminal-rail-row]' : '[data-testid="sortable-tab"]'
      ).length,
    surface
  )

/**
 * Drive the app to one surface through its own action and PROVE the DOM followed, then measure.
 *
 * Re-applying inside the poll rather than toggling once and hoping: a surface change that silently
 * did not happen still leaves the counters readable, and reads exactly like a real measurement.
 */
async function station(
  page: Page,
  worktreeId: string,
  surface: Surface,
  scale: number
): Promise<Station> {
  await expect
    .poll(
      () =>
        page.evaluate((railCollapsed) => {
          const s = window.__store!.getState()
          if (s.terminalRailCollapsed !== railCollapsed) {
            s.toggleTerminalRailCollapsed()
          }
          return window.__store!.getState().terminalRailCollapsed === true
        }, surface.railCollapsed),
      { timeout: 20_000, message: `${surface.name} never reached its collapse state` }
    )
    .toBe(surface.railCollapsed)
  await expect
    .poll(() => countRows(page, surface.name), {
      timeout: 20_000,
      message: `${surface.name} never mounted ${scale} rows`
    })
    .toBe(scale)
  await settle(page)

  const measure = async (kind: 'unrelated' | 'relevant'): Promise<ProjectionCounters> => {
    await page.evaluate(() => window.__tabAgentProjectionE2E!.reset())
    await writeAndSettle(page, kind)
    return page.evaluate(() => window.__tabAgentProjectionE2E!.read())
  }

  // Unrelated first: the relevant write leaves a fresh generation behind, and measuring the zero
  // after it would be measuring a cache that had just been rebuilt for other reasons.
  const unrelated = await measure('unrelated')
  const relevant = await measure('relevant')
  const mounted = await countRows(page, surface.name)
  expect(mounted, `${surface.name} lost rows mid-station`).toBe(scale)
  return { scale, surface: surface.name, mounted, unrelated, relevant }
}

test.describe.configure({ mode: 'serial' })

test('what an unrelated store write costs 50 dormant rows in the real app', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.setTimeout(15 * 60_000)
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }

  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null

  try {
    // ── Seed: capture two REAL rows through the real producer, clone to each scale ──
    const first = await session.launch()
    app = first.app
    const page = await app.firstWindow()
    const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)
    await page.evaluate((wt) => window.__store!.getState().createTab(wt), worktreeId)
    await expect
      .poll(
        async () =>
          page.evaluate(
            (wt) => window.__store!.getState().tabsByWorktree[wt]?.length ?? 0,
            worktreeId
          ),
        { timeout: 30_000, message: 'two source rows' }
      )
      .toBe(2)

    const saved = await page.evaluate(
      (wt) => window.__workingSetE2E!.save({ ownerKey: wt, label: 'derivation-source' }),
      worktreeId
    )
    expect(saved).toMatchObject({ status: 'saved' })
    const sourceId = (saved as { workingSetId: string }).workingSetId
    const dir = findArtifactDir(session.userDataDir, sourceId)
    const outcome = readProjectWorkingSetManifest(
      JSON.parse(readFileSync(join(dir, `${sourceId}.json`), 'utf-8'))
    )
    expect(outcome.status).toBe('valid')
    if (outcome.status !== 'valid') {
      return
    }
    const scaledIds = new Map<number, string>()
    for (const scale of SCALES) {
      const scaledId = globalThis.crypto.randomUUID()
      scaledIds.set(scale, scaledId)
      writeFileSync(
        join(dir, `${scaledId}.json`),
        JSON.stringify(
          cloneWorkingSetToScale(outcome.manifest, scale, {
            newId: () => globalThis.crypto.randomUUID(),
            workingSetId: scaledId
          }),
          null,
          2
        ),
        'utf-8'
      )
    }
    await emptyWorkspace(page, worktreeId)
    await session.close(app)
    app = null

    // ── The experiment: ONE fresh app, each scale restored into it in turn ──
    const launched = await session.launch()
    app = launched.app
    const point = launched.page
    await waitForSessionReady(point)
    await emptyWorkspace(point, worktreeId)
    await settle(point)

    const stations: Station[] = []
    for (const scale of SCALES) {
      const restored = await point.evaluate(
        ({ s, id }) => window.__workingSetE2E!.restore({ scope: s, workingSetId: id }),
        {
          s: { executionHostId: 'local' as const, ownerKey: worktreeId },
          id: scaledIds.get(scale)!
        }
      )
      expect(restored).toMatchObject({ status: 'planned', applied: { status: 'applied' } })
      await point.evaluate((wt) => window.__store!.getState().setActiveWorktree(wt), worktreeId)
      await ensureTerminalVisible(point)
      await settle(point)

      const seeded = await point.evaluate((wt) => {
        const s = window.__store!.getState()
        const tabs = s.tabsByWorktree[wt] ?? []
        return {
          tabs: tabs.length,
          withPty: tabs.filter((t) => (s.ptyIdsByTabId[t.id] ?? []).length > 0).length
        }
      }, worktreeId)
      expect(seeded.tabs, `store holds ${scale} rows`).toBe(scale)
      // Derivation measured while something is running is not a dormant row's derivation.
      expect(seeded.withPty, 'no restored row has a process').toBe(0)

      for (const surface of SURFACES) {
        stations.push(await station(point, worktreeId, surface, scale))
      }
      await emptyWorkspace(point, worktreeId)
      await settle(point)
    }

    for (const s of stations) {
      console.log(
        `[w3-reality] scale=${s.scale} surface=${s.surface} mounted=${s.mounted} ` +
          `unrelated{gen=${s.unrelated.generations} derive=${s.unrelated.derivations} ` +
          `paneKeys=${s.unrelated.paneKeys} hits=${s.unrelated.cacheHits}} ` +
          `relevant{gen=${s.relevant.generations} derive=${s.relevant.derivations} ` +
          `paneKeys=${s.relevant.paneKeys} reused=${s.relevant.reusedReferences}}`
      )
    }

    for (const s of stations) {
      const where = `${s.surface}@${s.scale}`

      // ── The positive control, asserted first: without it every zero below is uninterpretable ──
      // A write that genuinely moves the projection's inputs must still cost the full per-row
      // derivation. This is what separates "the projection works" from "the instrument is dead",
      // "the surface unmounted" and "the exposure never bound".
      expect(s.relevant.generations, `${where} relevant write opened a generation`).toBe(1)
      expect(
        s.relevant.derivations,
        `${where} relevant write re-derived every mounted row`
      ).toBeGreaterThanOrEqual(s.scale)
      expect(
        s.relevant.paneKeys,
        `${where} relevant write minted a pane key per row`
      ).toBeGreaterThanOrEqual(s.scale)
      // Necessary derivation, unnecessary invalidation: the write was content-equal, so every row's
      // value is unchanged and every reference must survive. Delete `reuseIfUnchanged` and the
      // derivation counts above stay exactly the same while this one collapses to zero.
      expect(
        s.relevant.reusedReferences,
        `${where} unchanged rows kept their reference`
      ).toBeGreaterThanOrEqual(s.scale)

      // ── The contract ──
      expect(s.unrelated.generations, `${where} unrelated write opened no generation`).toBe(0)
      expect(s.unrelated.derivations, `${where} unrelated write derived nothing`).toBe(0)
      expect(s.unrelated.paneKeys, `${where} unrelated write minted no pane key`).toBe(0)
      // Not merely "did not derive": every row was genuinely asked on that write, so a surface that
      // had silently stopped subscribing cannot pass this as if it were the projection working.
      expect(
        s.unrelated.cacheHits,
        `${where} every row still asked on the unrelated write`
      ).toBeGreaterThanOrEqual(s.scale)
    }
  } finally {
    if (app) {
      await session.close(app)
    }
  }
})
