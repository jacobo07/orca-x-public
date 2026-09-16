import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import type { AppState } from '@/store/types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { gateOrcaSelectedResume } from '@/lib/live-session-collision-gate'
import {
  planPaneSessionResume,
  readPaneSessionResumeCapability,
  type PaneSessionResumeCapability,
  type PaneSessionResumeTarget
} from '@/lib/pane-session-resume-capability'
import type { RecordedAgentResumePlan } from '@/lib/recorded-agent-resume-plan'
import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent
} from '../../../shared/agent-session-resume'
import type { LiveSessionResumeRefusal } from '../../../shared/live-agent-session-presence-types'

export type PaneSessionResumeStartup = {
  command: string
  env: Record<string, string>
  launchConfig: RecordedAgentResumePlan['launchConfig']
  resumeProviderSession: AgentProviderSessionMetadata
  launchToken: string
  launchAgent: ResumableTuiAgent
}

export type PaneSessionRespawnResult =
  | {
      kind: 'spawned'
      ptyId: string
      previousPtyId: string | null
      reattached: boolean
      agentResumeRefused?: LiveSessionResumeRefusal
    }
  | { kind: 'failed' }

export type PaneSessionResumeResult =
  | { outcome: 'started' }
  | { outcome: 'cancelled' }
  | { outcome: 'blocked'; reason: LiveSessionResumeRefusal }
  | { outcome: 'unavailable'; capability: PaneSessionResumeCapability }
  | { outcome: 'spawn-failed' }

type MaterializationApi = {
  attachMaterializationTab: (args: { operationId: string; tabId: string }) => Promise<boolean>
  releaseMaterialization: (args: { operationId: string }) => Promise<void>
}

/**
 * Resumes the exact provider session this pane exited from, in this pane.
 *
 * Never writes the pane's record: the exit block clears only when the provider reports
 * the session live again, and a failed attempt keeps the session for a retry.
 */
export async function resumePaneSession(args: {
  target: PaneSessionResumeTarget
  confirm: ConfirmationDialogContextValue | null
  respawn: (startup: PaneSessionResumeStartup) => Promise<PaneSessionRespawnResult>
  getState: () => AppState
  materialization?: MaterializationApi
}): Promise<PaneSessionResumeResult> {
  const { target } = args
  const materialization = args.materialization ?? window.api.agentStatus
  const initial = currentPlan(args.getState(), target)
  if ('outcome' in initial) {
    return initial
  }
  const { record } = initial
  const gate = await gateOrcaSelectedResume({
    worktreeId: target.worktreeId,
    agent: record.agent,
    providerSession: record.providerSession,
    paneKey: target.paneKey,
    launchesThroughRuntime: false,
    confirm: args.confirm
  })
  if (gate.outcome === 'cancelled') {
    return { outcome: 'cancelled' }
  }
  const operationId = gate.materialization?.operationId ?? null
  const release = (): void => {
    if (operationId) {
      void materialization.releaseMaterialization({ operationId }).catch(() => {})
    }
  }
  // Why re-read: the dialog can stay open while the user resumes by hand or starts another session.
  const current = currentPlan(args.getState(), target)
  if ('outcome' in current) {
    release()
    return current
  }
  if (
    current.record.agent !== record.agent ||
    !agentProviderSessionsEqual(
      record.agent,
      current.record.providerSession,
      record.providerSession
    )
  ) {
    release()
    return { outcome: 'unavailable', capability: { kind: 'hidden' } }
  }
  if (operationId) {
    // Why before the spawn: main's spawn gate lets a reserved session through only into the tab
    // its operation attached; unattached, the spawn would be refused as "starting".
    await materialization
      .attachMaterializationTab({ operationId, tabId: target.tabId })
      .catch(() => false)
  }
  const launchToken = createBrowserUuid()
  const { plan } = current
  let result: PaneSessionRespawnResult
  try {
    result = await args.respawn({
      command: plan.launchCommand,
      env: { ...plan.env, ORCA_AGENT_LAUNCH_TOKEN: launchToken },
      launchConfig: plan.launchConfig,
      resumeProviderSession: current.record.providerSession,
      launchToken,
      launchAgent: current.record.agent
    })
  } catch {
    result = { kind: 'failed' }
  }
  if (result.kind === 'failed') {
    release()
    return { outcome: 'spawn-failed' }
  }
  if (result.agentResumeRefused) {
    release()
    return { outcome: 'blocked', reason: result.agentResumeRefused }
  }
  // Why: adopting the old shell (or no new process) resumed nothing.
  if (result.reattached || result.ptyId === result.previousPtyId) {
    release()
    return { outcome: 'spawn-failed' }
  }
  return { outcome: 'started' }
}

function currentPlan(
  state: AppState,
  target: PaneSessionResumeTarget
):
  | NonNullable<ReturnType<typeof planPaneSessionResume>>
  | { outcome: 'unavailable'; capability: PaneSessionResumeCapability } {
  const capability = readPaneSessionResumeCapability(state, target)
  if (capability.kind !== 'available') {
    return { outcome: 'unavailable', capability }
  }
  const planned = planPaneSessionResume(state, target)
  return (
    planned ?? { outcome: 'unavailable', capability: { kind: 'unavailable', reason: 'no-plan' } }
  )
}
