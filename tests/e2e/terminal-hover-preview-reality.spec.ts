import { randomUUID } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree } from './helpers/store'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import {
  execInTerminal,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'

/**
 * The hover preview, in a running Orca.
 *
 * Unit tests proved the modules; they cannot prove the capability. What is checked here is the part
 * that only exists at runtime: that hovering a rail row shows *that* terminal, and that looking at a
 * terminal does not change it. The second half is the product law — observation must not alter the
 * observed — and the only honest way to check it is to read the geometry the main process actually
 * applied, before and after, rather than trusting that no resize call was written.
 *
 * The target is deliberately the pane that is NOT active. A preview of the terminal you are already
 * in would pass every assertion below while demonstrating nothing.
 */

/** Enough ticks to still be emitting while the card is open; small enough not to flood the PTY. */
const TICK_INTERVAL_MS = 200
const TOTAL_TICKS = 600

function tickingWorkload(marker: string): string {
  return `
let tick = 0
const timer = setInterval(() => {
  tick += 1
  process.stdout.write(${JSON.stringify(marker)} + '-' + tick + '\\n')
  if (tick >= ${TOTAL_TICKS}) {
    clearInterval(timer)
  }
}, ${TICK_INTERVAL_MS})
`
}

type PaneUnderTest = { leafId: string; ptyId: string }

/** Applied cols/rows from the main process — the PTY's real geometry, not the renderer's request. */
async function readAppliedSize(
  page: Page,
  ptyId: string
): Promise<{ cols: number; rows: number } | null> {
  return page.evaluate(async (id) => (await window.api?.pty?.getSize?.(id)) ?? null, ptyId)
}

async function readActiveLeafId(page: Page, tabId: string): Promise<string | null> {
  return page.evaluate(
    (id) => window.__paneManagers?.get(id)?.getActivePane?.()?.leafId ?? null,
    tabId
  )
}

/**
 * Split the active terminal and return the two panes with the active one named.
 *
 * Both panes are visible, so "non-active" here means exactly what it means to a user: not the pane
 * they are typing into. That is the state the preview exists for.
 */
async function splitAndIdentify(
  page: Page
): Promise<{ tabId: string; active: PaneUnderTest; other: PaneUnderTest }> {
  await splitActiveTerminalPane(page, 'vertical')
  const snapshot = await waitForPaneIdentitySnapshot(page, 2)
  const activeLeafId = snapshot.activeLeafId ?? snapshot.panes[0]?.leafId ?? null
  expect(activeLeafId, 'the split left no active pane to compare against').toBeTruthy()

  const panes = snapshot.panes.map((pane) => ({
    leafId: pane.leafId,
    ptyId: pane.ptyId as string
  }))
  const active = panes.find((pane) => pane.leafId === activeLeafId)
  const other = panes.find((pane) => pane.leafId !== activeLeafId)
  expect(active && other, 'the split did not produce two distinctly identified panes').toBeTruthy()
  return { tabId: snapshot.tabId, active: active as PaneUnderTest, other: other as PaneUnderTest }
}

/** The rail row for one pane. Scoped to the pane row so a tab row sharing a leaf cannot match. */
function paneRowTrigger(page: Page, leafId: string) {
  return page.locator(
    `[data-terminal-preview-leaf-id="${leafId}"]:has([data-terminal-rail-row-kind="pane"])`
  )
}

test.describe('@terminal-hover-preview-reality', () => {
  test('hovering a rail row shows that pane, and leaves it exactly as it was', async ({
    orcaPage
  }) => {
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForActivePanePtyId(orcaPage)
    await expect(orcaPage.locator('[data-terminal-rail]')).toBeVisible({ timeout: 30_000 })

    const { tabId, active, other } = await splitAndIdentify(orcaPage)
    const marker = `HOVER-${randomUUID().slice(0, 8)}`
    const staged = await runNodeScriptInTerminal(orcaPage, other.ptyId, tickingWorkload(marker))

    // Precondition, not decoration: a preview that shows nothing because nothing was produced would
    // otherwise be indistinguishable from a preview that is broken.
    await expect
      .poll(
        async () =>
          orcaPage.evaluate(
            async (id) =>
              (await window.api?.pty?.getMainBufferSnapshot?.(id, { scrollbackRows: 0 }))?.data ??
              '',
            other.ptyId
          ),
        { timeout: 30_000, message: 'the target terminal never produced its marker' }
      )
      .toContain(marker)

    const sizesBefore = {
      active: await readAppliedSize(orcaPage, active.ptyId),
      other: await readAppliedSize(orcaPage, other.ptyId)
    }
    const activeLeafBefore = await readActiveLeafId(orcaPage, tabId)
    expect(sizesBefore.other?.cols, 'no applied geometry to compare against').toBeGreaterThan(0)

    await paneRowTrigger(orcaPage, other.leafId).hover()

    const card = orcaPage.locator('[data-terminal-preview-card]')
    await expect(card).toBeVisible({ timeout: 15_000 })
    await expect(card).toHaveAttribute('data-terminal-preview-status', 'live', { timeout: 15_000 })

    // The subject, proved by content rather than by the label above it.
    await expect(orcaPage.locator('[data-terminal-preview-transcript]')).toContainText(marker, {
      timeout: 15_000
    })

    // It advances. Two different ticks, not merely a non-empty screen: a snapshot taken once and
    // never updated would satisfy every assertion up to this line.
    const readTranscript = async (): Promise<string> =>
      (await orcaPage.locator('[data-terminal-preview-transcript]').textContent()) ?? ''
    const firstSeen = (await readTranscript()).match(new RegExp(`${marker}-(\\d+)`, 'g'))?.at(-1)
    expect(firstSeen, 'no tick visible in the preview').toBeTruthy()
    await expect
      .poll(
        async () => (await readTranscript()).match(new RegExp(`${marker}-(\\d+)`, 'g'))?.at(-1),
        { timeout: 20_000, message: 'the preview never advanced past its first tick' }
      )
      .not.toBe(firstSeen)

    // The product law. Hovering is looking, not using.
    expect(await readActiveLeafId(orcaPage, tabId), 'hover changed which pane is active').toBe(
      activeLeafBefore
    )
    expect(
      await readAppliedSize(orcaPage, other.ptyId),
      'the preview resized the PTY it was watching'
    ).toEqual(sizesBefore.other)
    expect(
      await readAppliedSize(orcaPage, active.ptyId),
      'the preview resized the active PTY'
    ).toEqual(sizesBefore.active)

    await orcaPage.screenshot({ path: 'pr-evidence/terminal-hover-preview.png' })
    staged.cleanup()
  })

  test('moving to another row retargets, and never keeps showing the old terminal', async ({
    orcaPage
  }) => {
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForActivePanePtyId(orcaPage)
    await expect(orcaPage.locator('[data-terminal-rail]')).toBeVisible({ timeout: 30_000 })

    const { active, other } = await splitAndIdentify(orcaPage)
    const activeMarker = `LEFT-${randomUUID().slice(0, 8)}`
    const otherMarker = `RIGHT-${randomUUID().slice(0, 8)}`
    // Why one line each rather than the ticking workload: what is under test is which terminal the
    // card resolves, and distinct static content settles that. Running two emitters would add load
    // this property does not need — and a fixture heavy enough to exhaust the host reports a killed
    // run, which is not a verdict about the product.
    await execInTerminal(orcaPage, active.ptyId, `echo ${activeMarker}`)
    await execInTerminal(orcaPage, other.ptyId, `echo ${otherMarker}`)

    const transcript = orcaPage.locator('[data-terminal-preview-transcript]')
    await paneRowTrigger(orcaPage, other.leafId).hover()
    await expect(transcript).toContainText(otherMarker, { timeout: 15_000 })

    // Straight to the sibling. The card is shared, so a resolver that answered late — or answered
    // for the row the pointer just left — surfaces here as the wrong terminal under the new row.
    await paneRowTrigger(orcaPage, active.leafId).hover()
    await expect(transcript).toContainText(activeMarker, { timeout: 15_000 })
    await expect(transcript).not.toContainText(otherMarker)
  })
})
