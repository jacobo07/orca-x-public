import { expect, type Page } from '@stablyai/playwright-test'

export type HwfClientProbe = {
  webGitCommit: 'function' | 'undefined'
  webAgentStatus: 'present' | 'absent'
  sshAgentMenu: 'codex' | 'claude' | 'absent'
}

// Why: the three web/menu facts were inferred, not measured; every later Client B assertion branches on these values.
export async function probeHwfClientSurfaces(
  desktopPage: Page,
  webPage: Page
): Promise<HwfClientProbe> {
  await expect(webPage.locator('[data-worktree-sidebar]')).toBeVisible({ timeout: 30_000 })
  const webGitCommit = await webPage.evaluate(() =>
    typeof window.api?.git?.commit === 'function' ? ('function' as const) : ('undefined' as const)
  )
  const webAgentStatus = await webPage.evaluate(() =>
    'agentStatusByPaneKey' in (window.__store?.getState() ?? {})
      ? ('present' as const)
      : ('absent' as const)
  )
  return { webGitCommit, webAgentStatus, sshAgentMenu: await probeSshAgentMenu(desktopPage) }
}

async function probeSshAgentMenu(page: Page): Promise<HwfClientProbe['sshAgentMenu']> {
  await page.getByRole('button', { name: 'New tab' }).click({ force: true })
  // Station control: the menu itself must be visible before any item's absence means anything.
  await expect(page.getByRole('menu')).toBeVisible({ timeout: 15_000 })
  const codex = await page
    .getByRole('menuitem', { name: /^Codex(?:\s|$)/i })
    .first()
    .isVisible()
  const claude = await page
    .getByRole('menuitem', { name: /^Claude(?:\s|$)/i })
    .first()
    .isVisible()
  await page.keyboard.press('Escape')
  if (codex) {
    return 'codex'
  }
  return claude ? 'claude' : 'absent'
}
