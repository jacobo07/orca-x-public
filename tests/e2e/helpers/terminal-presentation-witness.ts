/**
 * The pixel witness: what the terminal surface is actually showing, as opposed to what its model
 * holds or what its child process has produced.
 *
 * Those three are separate layers and they fail independently, so localizing a "freeze" needs a
 * reading of each. The model is available through the SerializeAddon the PaneManager already loads;
 * the child can be watched through the filesystem. This is the one that had no seam.
 *
 * The sample is clipped to the top of the surface on purpose. A blinking cursor repaints one cell
 * every interval, so a full-surface comparison differs on every run whether or not content
 * advanced — and a comparison that cannot report "unchanged" cannot detect a stale surface. Scrolled
 * content turns the upper rows over completely while the cursor stays at the bottom, outside the
 * clip, which is what gives the witness a reachable "stale" verdict. Measured noise floor on a quiet
 * terminal is zero bytes; `restored-window-terminal-presentation.spec.ts` drives both verdicts.
 */

import type { Page } from '@stablyai/playwright-test'

/** Fraction of the surface sampled, measured from the top. Keeps the cursor row out of the sample. */
const SAMPLED_SURFACE_FRACTION = 0.55
/** Below this the element is not a laid-out terminal, and comparing its pixels proves nothing. */
const MIN_MEASURABLE_SURFACE_PX = 40

/**
 * Returns the sampled surface, or null when it cannot be measured — which is a setup failure and
 * must never be reported as a presentation result.
 */
export async function screenshotTerminalSurface(page: Page): Promise<Buffer | null> {
  const surface = page.locator('.xterm-screen').first()
  const box = await surface.boundingBox()
  if (
    !box ||
    box.width < MIN_MEASURABLE_SURFACE_PX ||
    box.height < MIN_MEASURABLE_SURFACE_PX
  ) {
    return null
  }
  return surface.screenshot({
    clip: {
      x: box.x,
      y: box.y,
      width: box.width,
      height: Math.floor(box.height * SAMPLED_SURFACE_FRACTION)
    }
  })
}

/** The subset of Orca's per-pane rendering diagnostics that says which renderer actually ran. */
export type TerminalRendererMode = {
  paneId: number
  gpuRenderingEnabled: boolean
  hasWebgl: boolean
  webglDisabledAfterContextLoss: boolean
  webglAttachFailedSinceRecovery: boolean
}

/**
 * Which renderer each live pane is actually using, read through the freeze report Orca already
 * installs in prod builds.
 *
 * Why a presentation test needs this: the stale-surface mechanisms this suite exists to catch —
 * glyph-atlas corruption, context loss, a refresh swallowed by the paused-render gate — live on the
 * WebGL path. A run that quietly fell back to the DOM renderer is standing on the permissive side
 * of that gap and can only report success, so a green is uninterpretable unless the run also says
 * which renderer produced it. Returns null when the report is unavailable, which is a setup
 * failure rather than a finding about renderers.
 */
export async function readTerminalRendererModes(page: Page): Promise<TerminalRendererMode[] | null> {
  return page.evaluate(async () => {
    const build = (
      window as unknown as {
        __orcaTerminalFreezeReport?: () => Promise<{ renderer?: { paneRendering?: unknown } }>
      }
    ).__orcaTerminalFreezeReport
    if (typeof build !== 'function') {
      return null
    }
    const report = await build()
    const panes = report?.renderer?.paneRendering
    return Array.isArray(panes) ? (panes as TerminalRendererMode[]) : null
  })
}

/** A workload whose every line differs, so the surface must visibly turn over as it runs. */
export function scrollingTerminalWorkload(markerPrefix: string, heartbeatPath?: string): string {
  const heartbeat = heartbeatPath
    ? `fs.appendFileSync(${JSON.stringify(heartbeatPath)}, tick + '\\n')`
    : ''
  return `
const fs = require('node:fs')
let tick = 0
setInterval(() => {
  tick += 1
  ${heartbeat}
  process.stdout.write('${markerPrefix}-' + tick + ' ' + '='.repeat(60) + '\\n')
}, 120)
`
}
