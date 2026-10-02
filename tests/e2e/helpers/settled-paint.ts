import type { Page } from '@stablyai/playwright-test'

/**
 * Wait until the page has painted its settled state: every finite animation finished, fonts loaded,
 * then two frames. A capture or computed-style read taken mid-transition shows the previous state.
 * Infinite animations (spinners) are skipped, or they would hold the wait forever; a finite one that
 * never finishes fails loudly instead of eating the test timeout.
 */
export async function settlePaint(page: Page, timeoutMs = 10_000): Promise<void> {
  await page.evaluate(async (limit) => {
    const frame = (): Promise<unknown> => new Promise((resolve) => requestAnimationFrame(resolve))
    // A transition started by the action just before (hover out, click) registers at the next style
    // recalc; collecting first would miss it.
    await frame()
    const finite = document.getAnimations().filter((animation) => {
      const end = animation.effect?.getComputedTiming().endTime
      return typeof end === 'number' && Number.isFinite(end)
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`settlePaint: ${finite.length} animation(s) unfinished after ${limit} ms`)
          ),
        limit
      )
    })
    try {
      await Promise.race([
        Promise.all([
          ...finite.map((animation) => animation.finished.catch(() => undefined)),
          document.fonts.ready
        ]),
        expired
      ])
    } finally {
      clearTimeout(timer)
    }
    await frame()
    await frame()
  }, timeoutMs)
}
