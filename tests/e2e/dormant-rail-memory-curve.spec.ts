/**
 * R3 density lab, logical dimension — the byte curve.
 *
 * Dormant Session Tax: Orca control-plane bytes at N dormant rows minus the same at the base
 * scenario, at steady state. Marginal Idle Session Cost is its slope.
 *
 * `dormant-rail-density.spec.ts` owns the structural claim (counts, load-independent). This owns the
 * bytes, which are NOT load-independent, so every point carries its own headroom bracket read from
 * the same instrument that reports the bytes, and a point whose sweep failed is `unmeasured` rather
 * than zero.
 *
 * One fresh app per point, so no point inherits another's allocator high-water mark. The sequence
 * runs forward and then reversed: if order mattered, the two sweeps disagree and the curve says so
 * instead of reporting the drift as a tax.
 *
 * Metric: whatever `processMemoryMetric` the host reports — working set on Windows. Series carrying
 * different metric names are never compared, so the name is asserted constant across the run.
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

/** 0 is the base scenario the tax is measured against: the same app with an empty workspace. */
const POINTS = [0, 1, 10, 50] as const
const SAMPLES = 5
const SAMPLE_GAP_MS = 700
/** Below this the host is trimming working sets, which is the metric — such a point is not a result. */
const HEADROOM_FLOOR_BYTES = 1_500_000_000

type Sample = {
  orca: number
  main: number
  renderer: number
  other: number
  terminalHost: number
  workload: number
  unattributed: number
  available: number
  sweep: string
  metric: string
}

type Point = {
  rows: number
  sweepIndex: number
  outcome: 'measured' | 'unmeasured' | 'inconclusive'
  samples: number
  orcaMedian: number
  orcaMin: number
  orcaMax: number
  mainMedian: number
  rendererMedian: number
  terminalHostMedian: number
  workloadMedian: number
  unattributedMedian: number
  availableBefore: number
  availableAfter: number
  ptysAtPoint: number
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

async function snapshot(page: Page): Promise<Sample> {
  return page.evaluate(async () => {
    const s = (await window.api.memory.getSnapshot()) as MemorySnapshot
    return {
      orca: s.app.memory,
      main: s.app.main.memory,
      renderer: s.app.renderer.memory,
      other: s.app.other.memory,
      terminalHost: s.app.terminalHost?.memory ?? 0,
      workload: s.worktrees.reduce((total, worktree) => total + worktree.memory, 0),
      unattributed: s.terminalHostDescendants?.memory ?? 0,
      available: s.host.availableMemory,
      sweep: s.processSweep ?? 'measured',
      metric: s.processMemoryMetric
    }
  }) as Promise<Sample>
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
      { timeout: 20_000, message: 'workspace did not empty' }
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

test.describe.configure({ mode: 'serial' })

test('the marginal cost of one more remembered row', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.setTimeout(20 * 60_000)
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }

  const session = createRestartSession(testInfo)
  const points: Point[] = []
  let app: ElectronApplication | null = null

  try {
    // ── Seeding launch: capture two REAL rows, clone the scales, leave the workspace empty ──
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
      (wt) => window.__workingSetE2E!.save({ ownerKey: wt, label: 'memory-curve-source' }),
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
    const idByRows = new Map<number, string>()
    for (const rows of POINTS) {
      if (rows === 0) {
        continue
      }
      const id = globalThis.crypto.randomUUID()
      const scaled = cloneWorkingSetToScale(outcome.manifest, rows, {
        newId: () => globalThis.crypto.randomUUID(),
        workingSetId: id
      })
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(scaled, null, 2), 'utf-8')
      idByRows.set(rows, id)
    }
    await emptyWorkspace(page, worktreeId)
    await session.close(app)
    app = null

    // ── The curve: one fresh app per point, forward then reversed ──
    const scope = { executionHostId: 'local' as const, ownerKey: worktreeId }
    const sweeps = [[...POINTS], [...POINTS].toReversed()]
    for (const [sweepIndex, order] of sweeps.entries()) {
      for (const rows of order) {
        const launched = await session.launch()
        app = launched.app
        const point = launched.page
        await waitForSessionReady(point)
        await emptyWorkspace(point, worktreeId)
        const before = await snapshot(point)

        if (rows > 0) {
          const restored = await point.evaluate(
            ({ s, id }) => window.__workingSetE2E!.restore({ scope: s, workingSetId: id }),
            { s: scope, id: idByRows.get(rows)! }
          )
          expect(restored).toMatchObject({ status: 'planned', applied: { status: 'applied' } })
          await point.evaluate((wt) => window.__store!.getState().setActiveWorktree(wt), worktreeId)
          await ensureTerminalVisible(point)
        }
        await settle(point)

        const railRows = await point.evaluate(
          (wt) => window.__store!.getState().tabsByWorktree[wt]?.length ?? 0,
          worktreeId
        )
        expect(railRows, `rail holds ${rows} rows`).toBe(rows)
        const ptys = await point.evaluate((wt) => {
          const s = window.__store!.getState()
          return (s.tabsByWorktree[wt] ?? []).filter(
            (t) => (s.ptyIdsByTabId[t.id] ?? []).length > 0
          ).length
        }, worktreeId)
        // A tax measured while something is running is not a dormant tax.
        expect(ptys, `no row has a process at ${rows} rows`).toBe(0)

        const taken: Sample[] = []
        for (let sample = 0; sample < SAMPLES; sample++) {
          taken.push(await snapshot(point))
          await point.waitForTimeout(SAMPLE_GAP_MS)
        }
        const after = taken.at(-1)!
        const metrics = new Set(taken.map((s) => s.metric))
        expect(metrics.size, 'the metric name changed mid-point').toBe(1)

        const failed = taken.some((s) => s.sweep !== 'measured')
        const starved =
          before.available < HEADROOM_FLOOR_BYTES || after.available < HEADROOM_FLOOR_BYTES
        const recorded: Point = {
          rows,
          sweepIndex,
          outcome: failed ? 'unmeasured' : starved ? 'inconclusive' : 'measured',
          samples: taken.length,
          orcaMedian: median(taken.map((s) => s.orca)),
          orcaMin: Math.min(...taken.map((s) => s.orca)),
          orcaMax: Math.max(...taken.map((s) => s.orca)),
          mainMedian: median(taken.map((s) => s.main)),
          rendererMedian: median(taken.map((s) => s.renderer)),
          terminalHostMedian: median(taken.map((s) => s.terminalHost)),
          workloadMedian: median(taken.map((s) => s.workload)),
          unattributedMedian: median(taken.map((s) => s.unattributed)),
          availableBefore: before.available,
          availableAfter: after.available,
          ptysAtPoint: ptys
        }
        points.push(recorded)
        console.log(
          `[r3-byte-curve] sweep=${sweepIndex} rows=${rows} ` +
            `orca=${mb(recorded.orcaMedian)}MB ` +
            `[${mb(recorded.orcaMin)}-${mb(recorded.orcaMax)}] ` +
            `main=${mb(recorded.mainMedian)} ` +
            `renderer=${mb(recorded.rendererMedian)} ` +
            `host=${mb(recorded.terminalHostMedian)} ` +
            `workload=${mb(recorded.workloadMedian)} ` +
            `unattributed=${mb(recorded.unattributedMedian)} ` +
            `free=${mb(before.available)}->${mb(after.available)}MB ` +
            `metric=${after.metric} outcome=${recorded.outcome}`
        )

        await session.close(app)
        app = null
      }
    }

    const out = process.env.ORCA_BYTE_CURVE_OUT
    if (out) {
      writeFileSync(out, JSON.stringify(points, null, 2), 'utf-8')
    }
    // Every point must be a result the vocabulary recognises; the curve itself is read from the log.
    expect(points).toHaveLength(POINTS.length * 2)
    expect(points.every((p) => p.ptysAtPoint === 0)).toBe(true)
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
})
