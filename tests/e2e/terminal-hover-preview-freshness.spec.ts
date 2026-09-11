import { randomUUID } from 'node:crypto'
import { expect, test } from './helpers/orca-app'
import {
  describeMeasurementEnvironment,
  evaluateMeasurementEnvironment,
  readMeasurementFloorBytes,
  readMemorySample,
  type MemorySample
} from './helpers/measurement-environment'
import { ensureTerminalVisible, waitForActiveWorktree } from './helpers/store'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import {
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'

/**
 * How fresh is the hover preview, in milliseconds?
 *
 * "Live" is a claim about time, so it has to be measured at the presentation boundary rather than
 * inferred from being wired to a live source. The measurement is made self-describing: each tick
 * carries the wall-clock time it was written, so first-sight minus emitted-at is an end-to-end
 * latency that owes nothing to how often this test happens to poll.
 *
 * Two surfaces are sampled on one clock, from inside the page, so neither reading is skewed relative
 * to the other: the authoritative main-side model (via getMainBufferSnapshot, which registers no
 * preview observer and so does not perturb what it measures) and the card's own transcript. The
 * difference between them is what the preview costs *over* the model — the number the SLO belongs to.
 *
 * This spec reports; it does not impose a budget it invented. The assertions here only establish that
 * the measurement happened and that freshness is bounded at all.
 */

const TICK_INTERVAL_MS = 200
const SAMPLE_INTERVAL_MS = 40
const SAMPLE_WINDOW_MS = 12_000
/** Below this the run measured too little to characterise anything, so it must say so. */
const MIN_TICKS_FOR_A_VERDICT = 8
/** Often enough to catch a collapse inside the window, rare enough not to become part of it. */
const HOST_SAMPLE_INTERVAL_MS = 250

function timestampedWorkload(marker: string): string {
  return `
let tick = 0
const timer = setInterval(() => {
  tick += 1
  process.stdout.write(${JSON.stringify(marker)} + '-' + tick + '-' + Date.now() + '\\n')
  if (tick >= 400) {
    clearInterval(timer)
  }
}, ${TICK_INTERVAL_MS})
`
}

type FreshnessSample = { tick: number; emittedAt: number; modelAt?: number; viewAt?: number }

const MEASUREMENT_FLOOR_BYTES = readMeasurementFloorBytes(process.env)
// Read at collection, so an unfit host costs one syscall rather than an Electron launch, a seeded
// repository and a twelve-second workload whose numbers would be unpublishable anyway.
const OPENING_ENVIRONMENT = evaluateMeasurementEnvironment({
  samples: [readMemorySample()],
  floorBytes: MEASUREMENT_FLOOR_BYTES
})

// Why printed rather than left to the skip reason: reporters do not surface a describe-level skip
// description, so an unfit host and a disabled test would look identical in the log — and a gate
// nobody can see firing is indistinguishable from one that never fires.
if (OPENING_ENVIRONMENT.verdict !== 'valid') {
  console.log(describeMeasurementEnvironment(OPENING_ENVIRONMENT))
}

test.describe('@terminal-hover-preview-freshness', () => {
  test.skip(
    OPENING_ENVIRONMENT.verdict !== 'valid',
    `${describeMeasurementEnvironment(OPENING_ENVIRONMENT)} — not measured, no verdict about the subject`
  )

  test('measures how far the preview trails the terminal it is showing', async ({ orcaPage }) => {
    const floorBytes = MEASUREMENT_FLOOR_BYTES
    const openingSample = readMemorySample()

    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForActivePanePtyId(orcaPage)
    await expect(orcaPage.locator('[data-terminal-rail]')).toBeVisible({ timeout: 30_000 })

    await splitActiveTerminalPane(orcaPage, 'vertical')
    const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 2)
    const activeLeafId = snapshot.activeLeafId ?? snapshot.panes[0]?.leafId
    const target = snapshot.panes.find((pane) => pane.leafId !== activeLeafId)
    expect(target?.ptyId, 'no non-active pane to measure').toBeTruthy()

    const marker = `FRESH-${randomUUID().slice(0, 8)}`
    const staged = await runNodeScriptInTerminal(
      orcaPage,
      target!.ptyId as string,
      timestampedWorkload(marker)
    )

    await orcaPage
      .locator(
        `[data-terminal-preview-leaf-id="${target!.leafId}"]:has([data-terminal-rail-row-kind="pane"])`
      )
      .hover()
    const card = orcaPage.locator('[data-terminal-preview-card]')
    await expect(card).toBeVisible({ timeout: 15_000 })
    await expect(card).toHaveAttribute('data-terminal-preview-status', 'live', { timeout: 15_000 })

    // Sampled on the host clock alongside the in-page sampler: a run that opened fit and then fell
    // through the floor has to be able to withdraw its own numbers rather than average them in.
    const hostSamples: MemorySample[] = [openingSample]
    const hostSampler = setInterval(() => {
      hostSamples.push(readMemorySample())
    }, HOST_SAMPLE_INTERVAL_MS)

    // Sampling runs inside the page so both surfaces share one clock and one event loop. Sampling
    // from the test process would put an IPC round trip between the two readings and bake that
    // asymmetry into the result.
    const samples: FreshnessSample[] = await orcaPage.evaluate(
      async ({ ptyId, marker, sampleIntervalMs, windowMs }) => {
        const byTick = new Map<number, { tick: number; emittedAt: number; modelAt?: number; viewAt?: number }>()
        const pattern = new RegExp(`${marker}-(\\d+)-(\\d+)`, 'g')

        const harvest = (text: string, field: 'modelAt' | 'viewAt', now: number): void => {
          pattern.lastIndex = 0
          let match = pattern.exec(text)
          while (match !== null) {
            const tick = Number(match[1])
            const emittedAt = Number(match[2])
            const existing = byTick.get(tick) ?? { tick, emittedAt }
            // First sight only: a tick stays on screen for many samples, and overwriting would
            // measure how long it lingered rather than how long it took to arrive.
            if (existing[field] === undefined) {
              existing[field] = now
            }
            byTick.set(tick, existing)
            match = pattern.exec(text)
          }
        }

        const deadline = Date.now() + windowMs
        while (Date.now() < deadline) {
          const snapshot = await window.api?.pty?.getMainBufferSnapshot?.(ptyId, {
            scrollbackRows: 0
          })
          harvest(snapshot?.data ?? '', 'modelAt', Date.now())
          harvest(
            document.querySelector('[data-terminal-preview-transcript]')?.textContent ?? '',
            'viewAt',
            Date.now()
          )
          await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs))
        }
        return [...byTick.values()].sort((a, b) => a.tick - b.tick)
      },
      {
        ptyId: target!.ptyId as string,
        marker,
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
        windowMs: SAMPLE_WINDOW_MS
      }
    )

    clearInterval(hostSampler)

    const environment = evaluateMeasurementEnvironment({ samples: hostSamples, floorBytes })
    console.log(describeMeasurementEnvironment(environment))
    if (environment.verdict !== 'valid') {
      // The samples exist and are deliberately not published. A latency taken while the host was
      // collapsing is a measurement of the host, and reporting it as the feature's number is the
      // defect this gate exists to prevent — so the run ends with no verdict rather than a wrong one.
      staged.cleanup()
      test.skip(
        true,
        `${describeMeasurementEnvironment(environment)} — ${samples.length} ticks collected and withdrawn`
      )
    }

    const complete = samples.filter(
      (sample) => sample.modelAt !== undefined && sample.viewAt !== undefined
    )
    // A run that observed almost nothing must say so rather than report a confident number over two
    // samples. Skipped ticks are normal at the window edges; a near-empty set is not.
    expect(
      complete.length,
      `only ${complete.length} ticks were seen on both surfaces — too few to characterise freshness`
    ).toBeGreaterThanOrEqual(MIN_TICKS_FOR_A_VERDICT)

    const percentile = (values: number[], fraction: number): number =>
      [...values].sort((a, b) => a - b)[
        Math.min(values.length - 1, Math.floor(values.length * fraction))
      ]
    const viewLatency = complete.map((sample) => (sample.viewAt as number) - sample.emittedAt)
    const modelLatency = complete.map((sample) => (sample.modelAt as number) - sample.emittedAt)
    const presentationLag = complete.map(
      (sample) => (sample.viewAt as number) - (sample.modelAt as number)
    )

    console.log(
      `[hover-freshness] ticks=${complete.length} sampleInterval=${SAMPLE_INTERVAL_MS}ms\n` +
        `  emit -> preview visible : p50=${percentile(viewLatency, 0.5)}ms p95=${percentile(viewLatency, 0.95)}ms max=${Math.max(...viewLatency)}ms\n` +
        `  emit -> model visible   : p50=${percentile(modelLatency, 0.5)}ms p95=${percentile(modelLatency, 0.95)}ms max=${Math.max(...modelLatency)}ms\n` +
        `  preview over model      : p50=${percentile(presentationLag, 0.5)}ms p95=${percentile(presentationLag, 0.95)}ms max=${Math.max(...presentationLag)}ms`
    )

    // Bounded at all. The budget this deserves is set from the numbers above, not guessed here.
    expect(percentile(viewLatency, 0.5)).toBeLessThan(SAMPLE_WINDOW_MS)
    staged.cleanup()
  })
})
