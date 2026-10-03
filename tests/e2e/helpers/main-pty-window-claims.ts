/**
 * Main's own per-window record of which renderer windows claim a PTY visible / active (D6), read
 * through the preload debug snapshot from any page. A MAIN_STATE observable, not a user-visible one.
 */

import type { Page } from '@stablyai/playwright-test'
import { redactPtyIdForDiagnostics } from '../../../src/shared/pty-delivery-diagnostics'

export type MainPtyWindowClaims = {
  /** False when main's per-PTY table has no row for the PTY. */
  present: boolean
  /** null = unknown (an older main that does not report claimants), never an empty claim set. */
  visibleClaimWindowIds: number[] | null
  activeClaimWindowIds: number[] | null
}

export async function readMainPtyWindowClaims(
  page: Page,
  ptyId: string
): Promise<MainPtyWindowClaims> {
  const redactedId = redactPtyIdForDiagnostics(ptyId)
  return page.evaluate(async (id) => {
    const snapshot = await window.api.pty.getRendererDeliveryDebugSnapshot()
    const row = snapshot.diagnostics.perPty.find((entry) => entry.id === id) as
      | { visibleClaimWindowIds?: unknown; activeClaimWindowIds?: unknown }
      | undefined
    const ids = (value: unknown): number[] | null =>
      Array.isArray(value) && value.every((key) => typeof key === 'number') ? value : null
    return {
      present: row !== undefined,
      visibleClaimWindowIds: ids(row?.visibleClaimWindowIds),
      activeClaimWindowIds: ids(row?.activeClaimWindowIds)
    }
  }, redactedId)
}
