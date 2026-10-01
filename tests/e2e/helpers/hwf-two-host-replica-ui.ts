import { expect, type Locator, type Page } from '@stablyai/playwright-test'

// Data handles only: the e2e host runs a Spanish locale, so no visible text is asserted.

export async function openProjectHostSettings(page: Page, repoId: string): Promise<void> {
  await page.evaluate((id) => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'repo', repoId: id })
    state.openSettingsPage()
  }, repoId)
}

/** Station control: the section that holds this setup's row, proven visible before any count. */
export async function stationReady(page: Page, setupId: string): Promise<Locator> {
  const section = page
    .locator('[data-replica-topology-section]')
    .filter({ has: page.locator(`[data-setup-id="${setupId}"]`) })
  await expect(section).toHaveCount(1, { timeout: 60_000 })
  await expect(section).toBeVisible({ timeout: 60_000 })
  return section
}

export async function countByMembership(section: Locator, value: string): Promise<number> {
  return section.locator(`[data-setup-id] [data-replica-membership="${value}"]`).count()
}

export async function collisionItems(section: Locator): Promise<number> {
  return section
    .locator('[data-replica-collisions] li[data-replica-membership="colliding"]')
    .count()
}

export async function rowMembership(section: Locator, setupId: string): Promise<string | null> {
  return section
    .locator(`[data-setup-id="${setupId}"] [data-replica-membership]`)
    .first()
    .getAttribute('data-replica-membership')
}

/** The row's host-health handle; null when the row carries none (never read as healthy). */
export async function hostHealthOf(section: Locator, setupId: string): Promise<string | null> {
  const handle = section.locator(`[data-setup-id="${setupId}"] [data-replica-host-health]`)
  if ((await handle.count()) === 0) {
    return null
  }
  return handle.first().getAttribute('data-replica-host-health')
}

/** Polls a data-handle read until it satisfies the predicate or the bound passes; returns the last value. */
export async function pollHandle<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs: number
): Promise<T> {
  const started = Date.now()
  let value = await read()
  while (!ok(value) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    value = await read()
  }
  return value
}
