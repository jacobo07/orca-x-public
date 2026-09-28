import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'

/**
 * Chooses the New agent project through the picker a person uses, and returns what the form holds.
 * 'first' must bind a real project — asserted, because binding "No project" by accident makes a
 * project-dependent test pass for the wrong reason.
 */
export async function pickNewAgentProject(
  page: Page,
  target: 'first' | 'none'
): Promise<string | null> {
  const trigger = page.getByTestId('new-agent-project')
  await trigger.click()
  const option =
    target === 'none'
      ? page.getByTestId('new-agent-project-none')
      : page.getByTestId('new-agent-project-option').first()
  await option.click()
  await expect(page.getByTestId('new-agent-project-list')).toHaveCount(0)
  const value = (await trigger.getAttribute('data-value')) ?? ''
  if (target === 'first') {
    expect(value).not.toBe('')
    return value
  }
  expect(value).toBe('')
  return null
}
