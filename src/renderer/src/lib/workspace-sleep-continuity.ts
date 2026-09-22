import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import type { AgentTranscriptPresenceRequest } from '../../../shared/agent-transcript-presence-request'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { parseExecutionHostId } from '../../../shared/execution-host'
import {
  resolveSleptResumeContinuity,
  type SleptPaneEvidence
} from '../../../shared/dormant-resume-continuity'
import type { WorkingSetFactPresence } from '../../../shared/project-working-set-store-types'
import type { DormantResumeContinuity } from '../../../shared/terminal-tab-types'

/**
 * What each tab of a workspace being slept may honestly promise, gathered BEFORE anything stops.
 *
 * Before release, on purpose: the question is about the world the pane is being taken out of, and
 * a probe run after the runtime is gone is asking about a different one. It is also the last
 * moment the answer is free — once the panes are down, nothing here knows what they were.
 *
 * Every probe is bounded by the host and they all run at once, so a stalled mount costs one
 * timeout for the whole workspace rather than one per pane. A timeout is `unknown`, which
 * withholds the promise; it never delays or refuses the sleep.
 */

export type TranscriptProbe = (
  request: AgentTranscriptPresenceRequest
) => Promise<WorkingSetFactPresence>

/** What this client can and cannot observe about the workspace it is about to sleep. */
export function readSleepContinuityInputs(
  state: AppState,
  worktreeId: string
): { location: WorkingSetFactPresence; probe: TranscriptProbe | null } {
  const worktree = state.getKnownWorktreeById(worktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : null
  const hostKind = parseExecutionHostId(getExecutionHostIdForWorktree(state, worktreeId))?.kind
  // Why the known set and not a stat: a directory this workspace has stopped tracking, or is
  // deleting, is not somewhere a pane can be brought back to. That is a fact this client owns.
  // Inferring presence from "a process was running there" would not be one.
  const location: WorkingSetFactPresence =
    worktree && !state.deleteStateByWorktreeId?.[worktreeId]?.isDeleting ? 'present' : 'unknown'
  // Why nothing but local may probe: this process can stat only its own filesystem, and an SSH or
  // runtime-routed pane's transcript lives on a host it cannot reach. That is unknown, not absent.
  // The runtime owner is the same authority the sleep's own stop is routed by, so the probe and the
  // release cannot disagree about where these panes live.
  const local =
    hostKind !== 'ssh' &&
    hostKind !== 'runtime' &&
    !repo?.connectionId &&
    getRuntimeEnvironmentIdForWorktree(state, worktreeId) === null
  const probe = local ? window.api?.agentStatus?.readTranscriptPresence : undefined
  return { location, probe: probe ? (request) => probe(request) : null }
}

export async function resolveSleepContinuityByTabId(args: {
  tabIds: readonly string[]
  /** The records this sleep captured, keyed by pane. */
  records: Readonly<Record<string, SleepingAgentSessionRecord>>
  /** Whether the workspace's own directory is still one this client knows. */
  location: WorkingSetFactPresence
  /** Null when there is nothing local to stat — a remote host, or a client without the probe. */
  probe: TranscriptProbe | null
}): Promise<Map<string, DormantResumeContinuity>> {
  const recordsByTabId = new Map<string, SleepingAgentSessionRecord[]>()
  for (const record of Object.values(args.records)) {
    if (record.tabId) {
      const existing = recordsByTabId.get(record.tabId)
      if (existing) {
        existing.push(record)
      } else {
        recordsByTabId.set(record.tabId, [record])
      }
    }
  }

  const transcriptOf = async (
    record: SleepingAgentSessionRecord
  ): Promise<WorkingSetFactPresence> => {
    if (!args.probe) {
      return 'unknown'
    }
    try {
      return await args.probe({
        agent: record.agent,
        sessionId: record.providerSession.id,
        ...(record.providerSession.transcriptPath
          ? { transcriptPath: record.providerSession.transcriptPath }
          : {})
      })
    } catch {
      // A probe that could not be delivered says nothing about the transcript.
      return 'unknown'
    }
  }

  const verdicts = await Promise.all(
    args.tabIds.map(async (tabId) => {
      const panes: SleptPaneEvidence[] = await Promise.all(
        (recordsByTabId.get(tabId) ?? []).map(async (record) => ({
          hasRecordedSession: true,
          transcript: await transcriptOf(record),
          location: args.location
        }))
      )
      return [tabId, resolveSleptResumeContinuity(panes)] as const
    })
  )
  return new Map(verdicts)
}
