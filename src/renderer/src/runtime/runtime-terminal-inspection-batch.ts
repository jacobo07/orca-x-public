import type { GlobalSettings } from '../../../shared/global-settings-types'
import { PTY_PROCESS_INSPECTION_BATCH_MAX_IDS } from '../../../shared/pty-process-inspection-batch'
import {
  inspectRuntimeTerminalProcess,
  isLocallyInspectedRuntimePty,
  type RuntimeTerminalProcessInspection
} from './runtime-terminal-inspection'

// Why 'failed' is separate from an inspection: nothing is known, so it can never prove an exit.
export type RuntimeTerminalProcessInspectionOutcome =
  | { status: 'inspected'; inspection: RuntimeTerminalProcessInspection }
  | { status: 'failed' }

type Settings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

async function inspectLocally(
  ptyIds: string[],
  outcomes: Map<string, RuntimeTerminalProcessInspectionOutcome>
): Promise<void> {
  const inspectProcesses = window.api.pty.inspectProcesses
  if (typeof inspectProcesses !== 'function') {
    // Why: a surface without the batch method keeps the per-pane call.
    await Promise.all(
      ptyIds.map(async (ptyId) => {
        try {
          const inspection = await window.api.pty.inspectProcess(ptyId)
          outcomes.set(ptyId, { status: 'inspected', inspection })
        } catch {
          outcomes.set(ptyId, { status: 'failed' })
        }
      })
    )
    return
  }
  const chunks: string[][] = []
  for (let i = 0; i < ptyIds.length; i += PTY_PROCESS_INSPECTION_BATCH_MAX_IDS) {
    chunks.push(ptyIds.slice(i, i + PTY_PROCESS_INSPECTION_BATCH_MAX_IDS))
  }
  await Promise.all(
    chunks.map(async (chunk) => {
      const requested = new Set(chunk)
      try {
        for (const entry of await inspectProcesses(chunk)) {
          // Why: keyed by id, and only ids this chunk asked about may be answered.
          if (!requested.has(entry.id)) {
            continue
          }
          outcomes.set(
            entry.id,
            entry.status === 'inspected'
              ? { status: 'inspected', inspection: entry.inspection }
              : { status: 'failed' }
          )
        }
      } catch (error) {
        // Why: a lost envelope leaves every pane in it unknown; the caller fills them in as failed.
        console.warn('[runtime-terminal-inspection] batch inspection failed', error)
      }
    })
  )
}

/** One answer per pane: local panes share one main-process call, runtime panes ask their host. */
export async function inspectRuntimeTerminalProcesses(
  settings: Settings,
  ptyIds: string[]
): Promise<Map<string, RuntimeTerminalProcessInspectionOutcome>> {
  const outcomes = new Map<string, RuntimeTerminalProcessInspectionOutcome>()
  const local: string[] = []
  const runtime: string[] = []
  for (const ptyId of new Set(ptyIds)) {
    ;(isLocallyInspectedRuntimePty(settings, ptyId) ? local : runtime).push(ptyId)
  }
  await Promise.all([
    local.length > 0 ? inspectLocally(local, outcomes) : undefined,
    // Why per pane: the runtime RPC has no batch method, so each remote pane is one round trip.
    ...runtime.map(async (ptyId) => {
      try {
        const inspection = await inspectRuntimeTerminalProcess(settings, ptyId)
        outcomes.set(ptyId, { status: 'inspected', inspection })
      } catch {
        outcomes.set(ptyId, { status: 'failed' })
      }
    })
  ])
  for (const ptyId of ptyIds) {
    if (!outcomes.has(ptyId)) {
      outcomes.set(ptyId, { status: 'failed' })
    }
  }
  return outcomes
}
