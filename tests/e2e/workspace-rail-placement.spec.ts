import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

// PRODUCT REALITY — the Owner's placement (2026-09-24): Workspace directly below Explorer.
//
// The unit tests pin DOM order in a mocked strip; this measures the real one. Locale-free handles
// only (the host may run Orca in Spanish): the panel's own `data-activity-bar-item` for Explorer and
// the next tab, and `data-workspace-activity` for Workspace and Terminals. The strip is also
// captured, after a painted frame, as visual evidence of what a person sees.

test.setTimeout(240_000)

test('@headful Workspace sits directly below Explorer in the real strip and opens the Workspace', async ({
  testRepoPath
}, testInfo) => {
  const session = createRestartSession(testInfo)
  try {
    const { app, page } = await session.launch()
    await attachRepoAndOpenTerminal(page, testRepoPath)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1400, 900))

    const explorer = page.locator('[data-activity-bar-item="explorer"]').first()
    const workspace = page.locator('[data-workspace-activity="agent-workspace"]')
    const nextTab = page.locator('[data-activity-bar-item="vault"]').first()
    const terminals = page.locator('[data-workspace-activity="workspace"]')

    // Station controls: the strip and its neighbours are on screen before anything is measured.
    await expect(explorer).toBeVisible()
    await expect(nextTab).toBeVisible()
    await expect(workspace).toHaveCount(1)
    await expect(workspace).toBeVisible()

    const e = (await explorer.boundingBox())!
    const w = (await workspace.boundingBox())!
    const n = (await nextTab.boundingBox())!
    // Same column, directly under Explorer, above the next panel tab.
    expect(Math.abs(w.x - e.x)).toBeLessThanOrEqual(2)
    expect(w.y).toBeGreaterThanOrEqual(e.y + e.height - 1)
    expect(w.y - (e.y + e.height)).toBeLessThanOrEqual(4)
    expect(n.y).toBeGreaterThanOrEqual(w.y + w.height - 1)

    // Terminals is its own entry, named in some language, and not the Workspace.
    await expect(terminals).toHaveCount(1)
    const terminalsLabel = (await terminals.getAttribute('aria-label')) ?? ''
    const workspaceLabel = (await workspace.getAttribute('aria-label')) ?? ''
    expect(terminalsLabel.length).toBeGreaterThan(0)
    expect(workspaceLabel.length).toBeGreaterThan(0)
    expect(terminalsLabel).not.toBe(workspaceLabel)

    // Visual evidence of the strip, taken after a painted frame and checked for content.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    const strip = {
      x: Math.max(0, Math.floor(e.x) - 4),
      y: Math.max(0, Math.floor(e.y) - 8),
      width: Math.ceil(e.width) + 8,
      height: Math.ceil(n.y + n.height - e.y) + 16
    }
    const shot = await app.evaluate(async ({ BrowserWindow }, rect) => {
      const win = BrowserWindow.getAllWindows()[0]!
      const image = await win.capturePage()
      const scale = image.getSize().width / win.getContentBounds().width
      const cropped = image.crop({
        x: Math.round(rect.x * scale),
        y: Math.round(rect.y * scale),
        width: Math.round(rect.width * scale),
        height: Math.round(rect.height * scale)
      })
      const bitmap = cropped.toBitmap()
      const colours = new Set<number>()
      for (let o = 0; o < bitmap.length; o += 4 * 7) {
        colours.add((bitmap[o]! << 16) | (bitmap[o + 1]! << 8) | bitmap[o + 2]!)
      }
      return { png: cropped.toPNG().toString('base64'), colours: colours.size }
    }, strip)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(testInfo.outputPath('workspace-rail-strip.png'), Buffer.from(shot.png, 'base64'))
    expect(shot.colours).toBeGreaterThan(4)

    // The entry opens the Workspace and says so.
    await workspace.click()
    await expect(page.getByTestId('conversations-page')).toBeVisible()
    await expect(workspace).toHaveAttribute('aria-current', 'page')

    await session.close(app)
  } finally {
    await session.dispose().catch((error: unknown) => {
      console.error('[rail-placement] dispose failed', error)
    })
  }
})
