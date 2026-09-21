/*
 * W1 ATTRIBUTION — what actually owns the ~1 MB of renderer per dormant row?
 *
 * The byte curve (`dormant-rail-memory-curve.spec.ts`) put the Dormant Session Tax at +41.3 MB
 * forward / +54.4 MB reversed over 50 remembered rows, and located 68-79% of it in the renderer.
 * It did not say WHAT in the renderer. The structural half counted the presentation subtrees a
 * dormant row mounts — 9 DOM / 24 subscribers in the rail, 13 DOM / 21 in the tab strip — and a
 * count is not a byte figure in either direction: 22 elements cannot BE a megabyte, and cannot
 * prove one is absent either.
 *
 * THREE STRUCTURAL FACTS WERE MEASURED HERE BEFORE ANY BYTE WAS BELIEVED, and each one killed the
 * experiment that preceded it:
 *
 *  1. The rail and the tab strip are MUTUALLY EXCLUSIVE AND THEY SWAP. Rail expanded: the strip
 *     renders 0 terminal tabs. Rail collapsed: the strip renders all 50. So collapsing the rail
 *     does not remove presentation, it RELOCATES it — and a rail-collapse A/B measures
 *     (rail − strip) ≈ 0 while reading exactly like "presentation is free".
 *  2. The top-level view does not gate it either: on `tasks`, with the rail expanded, the rail
 *     still renders all 50 rows.
 *  3. On `tasks` with the rail collapsed, the STRIP renders all 50.
 *
 * Together: there is no state reachable through product actions in which these rows exist and
 * neither surface is mounted. Presentation residency for terminal rows is UNCONDITIONAL — exactly
 * one surface is always resident, whichever the collapse flag selects, no matter what the user is
 * looking at. That is a finding about the architecture, and it is also why this spec cannot run an
 * on/off differential: the "off" state does not exist to be measured.
 *
 * So it measures what is real instead:
 *   - the within-process tax of 50 dormant rows, by emptying the workspace in the SAME process
 *     once every chunk is warm (so no cross-lifetime comparison is involved);
 *   - how much of that is JS heap (`performance.memory.usedJSHeapSize`, JS objects and fibers
 *     only) versus native renderer memory (working set minus heap: DOM, layout, GPU-side);
 *   - rail-mounted versus strip-mounted, which is the choice W3 would actually be making;
 *   - a repeated rail station, so every delta above is reported against its own drift bound.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { cloneWorkingSetToScale } from '../../src/shared/project-working-set-scale-clone'
import { readProjectWorkingSetManifest } from '../../src/shared/project-working-set-schema'
import type { MemorySnapshot } from '../../src/shared/process-stats-types'
import { waitForActiveTerminalManager, waitForPaneCount } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

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
  }
}

const ROWS = 50
const SAMPLES = 5
const SAMPLE_GAP_MS = 700
/** Below this the host is trimming working sets, which is the metric — such a point is not a result. */
const HEADROOM_FLOOR_BYTES = 1_500_000_000

type Surface = {
  name: string
  railCollapsed: boolean
  /** What the DOM must show once the surface settles. The experiment's own control. */
  expectRailRows: number
  expectStripTabs: number
  /** False for the warm-up station, whose only job is to get every chunk resident. */
  counts: boolean
}

const SURFACES: readonly Surface[] = [
  { name: 'warm', railCollapsed: false, expectRailRows: ROWS, expectStripTabs: 0, counts: false },
  { name: 'rail-1', railCollapsed: false, expectRailRows: ROWS, expectStripTabs: 0, counts: true },
  { name: 'strip', railCollapsed: true, expectRailRows: 0, expectStripTabs: ROWS, counts: true },
  { name: 'rail-2', railCollapsed: false, expectRailRows: ROWS, expectStripTabs: 0, counts: true }
]

type Reading = {
  /** Canonical lab metric: this renderer process's working set (win32) or RSS. */
  renderer: number
  orca: number
  /** JS objects only. Native DOM/layout/GPU allocations are NOT in here. */
  jsHeap: number | null
  available: number
  sweep: string
  metric: string
  railRowsInDom: number
  stripTabsInDom: number
  /** Store-side counts, so an empty SURFACE can be told apart from an empty STORE. */
  terminalTabsInStore: number
  unifiedTabsInStore: number
}

type Station = Surface & {
  outcome: 'measured' | 'unmeasured' | 'inconclusive'
  rendererMedian: number
  rendererMin: number
  rendererMax: number
  jsHeapMedian: number | null
  railRowsInDom: number
  stripTabsInDom: number
  terminalTabsInStore: number
  /** Every distinct sweep label seen, so "unmeasured" names its own cause instead of asserting it. */
  sweeps: string[]
  availableBefore: number
  availableAfter: number
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1)

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

async function read(page: Page, worktreeId: string): Promise<Reading> {
  return page.evaluate(async (wt) => {
    const s = (await window.api.memory.getSnapshot()) as MemorySnapshot
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } }
    const store = window.__store!.getState()
    return {
      renderer: s.app.renderer.memory,
      orca: s.app.memory,
      jsHeap: perf.memory?.usedJSHeapSize ?? null,
      available: s.host.availableMemory,
      sweep: s.processSweep ?? 'measured',
      metric: s.processMemoryMetric,
      railRowsInDom: document.querySelectorAll('[data-terminal-rail-row]').length,
      stripTabsInDom: document.querySelectorAll('[data-testid="sortable-tab"]').length,
      terminalTabsInStore: store.tabsByWorktree[wt]?.length ?? 0,
      unifiedTabsInStore: store.unifiedTabsByWorktree[wt]?.length ?? 0
    }
  }, worktreeId) as Promise<Reading>
}

async function mainSessionIds(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await window.api.pty.listSessions()).map((session) => session.id).sort()
  )
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
  let previous = await mainSessionIds(page)
  let stable = 0
  for (let attempt = 0; attempt < 40 && stable < 3; attempt++) {
    await page.waitForTimeout(250)
    const current = await mainSessionIds(page)
    stable = JSON.stringify(current) === JSON.stringify(previous) ? stable + 1 : 0
    previous = current
  }
  expect(stable, 'host session list never quiesced').toBeGreaterThanOrEqual(3)
}

/**
 * A CDP session, used for the two things the page cannot do for itself.
 *
 * MEASURED, and it is why this exists: `performance.memory.usedJSHeapSize` reported 54.2 MB at
 * every station AND at the zero-row floor — Chromium quantizes and caches it, so it is an
 * instrument that can only return one answer, which is no instrument at all. `Runtime.getHeapUsage`
 * is exact. And without a forced collection the renderer's working set swung 194.7-243.3 MB WITHIN
 * one station, a 48 MB spread against the ~41 MB effect being looked for, so GC timing rather than
 * row count decided every reading.
 */
type Probe = {
  collectGarbage: () => Promise<void>
  heapUsed: () => Promise<number | null>
}

async function attachProbe(page: Page): Promise<Probe> {
  try {
    const cdp = await page.context().newCDPSession(page)
    return {
      collectGarbage: async () => {
        await cdp.send('HeapProfiler.collectGarbage')
      },
      heapUsed: async () => {
        const usage = (await cdp.send('Runtime.getHeapUsage')) as { usedSize?: number }
        return typeof usage.usedSize === 'number' ? usage.usedSize : null
      }
    }
  } catch {
    // No CDP: the run still produces working-set numbers, and every heap figure reports null
    // rather than a fabricated zero.
    return { collectGarbage: async () => {}, heapUsed: async () => null }
  }
}

async function sample(page: Page, probe: Probe, worktreeId: string): Promise<Reading[]> {
  const first = await read(page, worktreeId)
  first.jsHeap = await probe.heapUsed()
  const taken: Reading[] = [first]
  for (let i = 1; i < SAMPLES; i++) {
    await probe.collectGarbage()
    await page.waitForTimeout(SAMPLE_GAP_MS)
    const next = await read(page, worktreeId)
    next.jsHeap = await probe.heapUsed()
    taken.push(next)
  }
  expect(new Set(taken.map((r) => r.metric)).size, 'the metric name changed mid-point').toBe(1)
  return taken
}

/**
 * Drive the app to one surface through its own action, PROVE the DOM and the store flag both
 * followed, then sample.
 *
 * Each poll iteration RE-APPLIES the wanted state rather than applying once and hoping: a surface
 * change that silently did not happen leaves the bytes readable and reads exactly like a real
 * measurement. Every one of the three structural facts above was found by this control failing.
 */
async function station(
  page: Page,
  probe: Probe,
  worktreeId: string,
  surface: Surface
): Promise<Station> {
  await expect
    .poll(
      () =>
        page.evaluate((railCollapsed) => {
          const s = window.__store!.getState()
          if (s.terminalRailCollapsed !== railCollapsed) {
            s.toggleTerminalRailCollapsed()
          }
          const now = window.__store!.getState()
          return {
            rail: document.querySelectorAll('[data-terminal-rail-row]').length,
            strip: document.querySelectorAll('[data-testid="sortable-tab"]').length,
            collapsedFlag: now.terminalRailCollapsed === true
          }
        }, surface.railCollapsed),
      { timeout: 20_000, message: `${surface.name} never reached its expected surface` }
    )
    .toEqual({
      rail: surface.expectRailRows,
      strip: surface.expectStripTabs,
      collapsedFlag: surface.railCollapsed
    })

  // Let the unmount's garbage become collectable, then actually collect it: settled by the
  // product's own quiescence, and by an explicit collection rather than by hoping one happened.
  await settle(page)
  await probe.collectGarbage()

  const taken = await sample(page, probe, worktreeId)
  const before = taken[0]
  const after = taken.at(-1)!
  // Judge each dimension by what it actually depends on. `processSweep` describes the CIM walk of
  // WORKLOAD processes; the renderer figure comes from Electron's own `getAppMetrics` and the heap
  // from CDP, and neither reads that sweep. MEASURED on this host: the sweep reports `failed` while
  // the renderer figure is stable to 0.1 MB across five samples — so gating the renderer verdict on
  // it invalidated a reading it has no bearing on. The sweep labels are carried into the record
  // instead, so the workload dimension stays honestly unmeasured without taking the rest with it.
  const starved = before.available < HEADROOM_FLOOR_BYTES || after.available < HEADROOM_FLOOR_BYTES
  const heaps = taken.map((r) => r.jsHeap).filter((v): v is number => v !== null)

  return {
    ...surface,
    outcome: starved ? 'inconclusive' : heaps.length === taken.length ? 'measured' : 'unmeasured',
    rendererMedian: median(taken.map((r) => r.renderer)),
    rendererMin: Math.min(...taken.map((r) => r.renderer)),
    rendererMax: Math.max(...taken.map((r) => r.renderer)),
    jsHeapMedian: heaps.length === taken.length ? median(heaps) : null,
    railRowsInDom: after.railRowsInDom,
    stripTabsInDom: after.stripTabsInDom,
    terminalTabsInStore: after.terminalTabsInStore,
    sweeps: [...new Set(taken.map((r) => r.sweep))],
    availableBefore: before.available,
    availableAfter: after.available
  }
}

test.describe.configure({ mode: 'serial' })

test('what 50 dormant rows cost the renderer, by mounted surface', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.setTimeout(20 * 60_000)
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }

  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null

  try {
    // ── Seed: capture two REAL rows through the real producer, clone to ROWS, empty the workspace ──
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
      (wt) => window.__workingSetE2E!.save({ ownerKey: wt, label: 'attribution-source' }),
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
    const scaledId = globalThis.crypto.randomUUID()
    writeFileSync(
      join(dir, `${scaledId}.json`),
      JSON.stringify(
        cloneWorkingSetToScale(outcome.manifest, ROWS, {
          newId: () => globalThis.crypto.randomUUID(),
          workingSetId: scaledId
        }),
        null,
        2
      ),
      'utf-8'
    )
    await emptyWorkspace(page, worktreeId)
    await session.close(app)
    app = null

    // ── The experiment: ONE fresh app, ROWS restored, presentation varied inside it ──
    const launched = await session.launch()
    app = launched.app
    const point = launched.page
    const probe = await attachProbe(point)
    await waitForSessionReady(point)
    await emptyWorkspace(point, worktreeId)
    await settle(point)

    const restored = await point.evaluate(
      ({ s, id }) => window.__workingSetE2E!.restore({ scope: s, workingSetId: id }),
      { s: { executionHostId: 'local' as const, ownerKey: worktreeId }, id: scaledId }
    )
    expect(restored).toMatchObject({ status: 'planned', applied: { status: 'applied' } })
    await point.evaluate((wt) => window.__store!.getState().setActiveWorktree(wt), worktreeId)
    await ensureTerminalVisible(point)
    await settle(point)

    const seeded = await read(point, worktreeId)
    expect(seeded.terminalTabsInStore, `store holds ${ROWS} rows`).toBe(ROWS)
    const ptys = await point.evaluate((wt) => {
      const s = window.__store!.getState()
      return (s.tabsByWorktree[wt] ?? []).filter((t) => (s.ptyIdsByTabId[t.id] ?? []).length > 0)
        .length
    }, worktreeId)
    // A tax measured while something is running is not a dormant tax.
    expect(ptys, 'no restored row has a process').toBe(0)

    const stations: Station[] = []
    for (const surface of SURFACES) {
      stations.push(await station(point, probe, worktreeId, surface))
    }
    const counted = stations.filter((s) => s.counts)
    const by = (name: string): Station => counted.find((s) => s.name === name)!

    // The store is the constant across every station: only the mounted surface moved.
    for (const s of stations) {
      expect(s.terminalTabsInStore, `${s.name} store is constant`).toBe(ROWS)
    }

    // ── The zero-row floor, taken LAST and in the SAME process, with every chunk already warm ──
    await emptyWorkspace(point, worktreeId)
    await settle(point)
    await probe.collectGarbage()
    const emptied = await sample(point, probe, worktreeId)
    const floorAfter = emptied.at(-1)!
    expect(floorAfter.terminalTabsInStore, 'workspace emptied for the floor').toBe(0)
    expect(
      floorAfter.railRowsInDom + floorAfter.stripTabsInDom,
      'no row survives the emptied floor'
    ).toBe(0)
    const floorRenderer = median(emptied.map((r) => r.renderer))
    const floorHeaps = emptied.map((r) => r.jsHeap).filter((v): v is number => v !== null)
    const floorHeap = floorHeaps.length === emptied.length ? median(floorHeaps) : null
    // Same scoping as a station: the workload sweep does not decide whether a renderer figure is
    // usable.
    const floorUsable =
      floorHeap !== null && emptied.every((r) => r.available >= HEADROOM_FLOOR_BYTES)

    // ── Attribution ──
    const railMedian = median([by('rail-1').rendererMedian, by('rail-2').rendererMedian])
    const drift = Math.abs(by('rail-1').rendererMedian - by('rail-2').rendererMedian)
    const railVsStrip = railMedian - by('strip').rendererMedian
    const taxRail = railMedian - floorRenderer
    const perRow = taxRail / ROWS

    const heapUsable = counted.every((s) => s.jsHeapMedian !== null) && floorHeap !== null
    const heapRail = heapUsable
      ? median([by('rail-1').jsHeapMedian!, by('rail-2').jsHeapMedian!])
      : null
    const heapDrift = heapUsable
      ? Math.abs(by('rail-1').jsHeapMedian! - by('rail-2').jsHeapMedian!)
      : null
    const heapTax = heapRail !== null && floorHeap !== null ? heapRail - floorHeap : null
    const nativeTax = heapTax !== null ? taxRail - heapTax : null

    const anyUnusable = counted.some((s) => s.outcome !== 'measured') || !floorUsable
    const verdict = anyUnusable
      ? 'INCONCLUSIVE-HOST'
      : taxRail > drift
        ? 'TAX-MEASURED'
        : 'TAX-BELOW-DETECTION'

    for (const s of stations) {
      console.log(
        `[w1-attribution] station=${s.name} counts=${s.counts} outcome=${s.outcome} ` +
          `renderer=${mb(s.rendererMedian)}MB [${mb(s.rendererMin)}-${mb(s.rendererMax)}] ` +
          `jsHeap=${s.jsHeapMedian === null ? 'null' : mb(s.jsHeapMedian) + 'MB'} ` +
          `railRows=${s.railRowsInDom} stripTabs=${s.stripTabsInDom} ` +
          `storeTabs=${s.terminalTabsInStore} sweeps=${s.sweeps.join('|')} ` +
          `availMB=${mb(s.availableBefore)}->${mb(s.availableAfter)}`
      )
    }
    console.log(
      `[w1-attribution] rows=${ROWS} ptys=${ptys} floorUsable=${floorUsable} ` +
        `floorRenderer=${mb(floorRenderer)}MB ` +
        `floorHeap=${floorHeap === null ? 'null' : mb(floorHeap) + 'MB'} ` +
        `railMedian=${mb(railMedian)}MB stripMedian=${mb(by('strip').rendererMedian)}MB ` +
        `taxRail=${mb(taxRail)}MB perRow=${(perRow / 1024).toFixed(1)}KB ` +
        `railMinusStrip=${mb(railVsStrip)}MB driftBound=${mb(drift)}MB ` +
        `heapTax=${heapTax === null ? 'null' : mb(heapTax) + 'MB'} ` +
        `nativeTax=${nativeTax === null ? 'null' : mb(nativeTax) + 'MB'} ` +
        `heapDrift=${heapDrift === null ? 'null' : mb(heapDrift) + 'MB'} ` +
        `verdict=${verdict}`
    )

    // The spec's job is to produce an attributable number, not a preferred one: both verdicts are
    // legitimate results, and only a host that could not hold still is a failure.
    expect(verdict, 'the host moved too much for any station to count').not.toBe('INCONCLUSIVE-HOST')
  } finally {
    if (app) {
      await session.close(app)
    }
  }
})
