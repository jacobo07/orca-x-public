/**
 * Main's own per-window record of which renderer windows claim a PTY visible / active (D6), read
 * through the preload debug snapshot from any page. A MAIN_STATE observable, not a user-visible one.
 */

import type { Page } from '@stablyai/playwright-test'
import {
  PTY_DELIVERY_DIAGNOSTICS_MAX_PTYS,
  redactPtyIdForDiagnostics
} from '../../../src/shared/pty-delivery-diagnostics'

export type MainPtyWindowClaims = {
  /** False when main's per-PTY table has no row for the PTY. */
  present: boolean
  /** null = unknown (older main without claimants, or a capped table), never an empty claim set. */
  visibleClaimWindowIds: number[] | null
  activeClaimWindowIds: number[] | null
}

export async function readMainPtyWindowClaims(
  page: Page,
  ptyId: string
): Promise<MainPtyWindowClaims> {
  const redactedId = redactPtyIdForDiagnostics(ptyId)
  return page.evaluate(
    async ({ id, maxRows }) => {
      const { perPty } = (await window.api.pty.getRendererDeliveryDebugSnapshot()).diagnostics
      const row = perPty.find((entry) => entry.id === id) as
        | { visibleClaimWindowIds?: unknown; activeClaimWindowIds?: unknown }
        | undefined
      if (!row) {
        // Why []: main lists every PTY in its claim unions, so a missing row in an uncapped table is no claim at all.
        const known = perPty.length < maxRows ? [] : null
        return { present: false, visibleClaimWindowIds: known, activeClaimWindowIds: known }
      }
      const ids = (value: unknown): number[] | null =>
        Array.isArray(value) && value.every((key) => typeof key === 'number') ? value : null
      return {
        present: true,
        visibleClaimWindowIds: ids(row.visibleClaimWindowIds),
        activeClaimWindowIds: ids(row.activeClaimWindowIds)
      }
    },
    { id: redactedId, maxRows: PTY_DELIVERY_DIAGNOSTICS_MAX_PTYS }
  )
}
