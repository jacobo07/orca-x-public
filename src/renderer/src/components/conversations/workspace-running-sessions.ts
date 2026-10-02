import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  deriveHostReachability,
  hostVouches,
  type HostReachability,
  type HostReachabilityEvidence
} from '@/lib/host-reachability'

export type RunningSessionHostIndex = ReadonlyMap<
  ExecutionHostId,
  { label: string; reachability: HostReachability }
>

/** The host readings sessions are joined to — derived the same way Workstation derives them. */
export function indexHostReachability(
  hosts: readonly (HostReachabilityEvidence & { id: ExecutionHostId; label: string })[]
): RunningSessionHostIndex {
  return new Map(
    hosts.map((host) => [
      host.id,
      { label: host.label, reachability: deriveHostReachability(host) }
    ])
  )
}

/**
 * 'host-unvouched' outranks the agent's own state: a host Orca is not observing cannot vouch for
 * it. WHY it cannot (never connected, attempt failed, version mismatch) is `hostReachability` —
 * never "offline", which Orca would have to observe.
 */
export type RunningSessionLiveness = 'needs-you' | 'working' | 'done' | 'idle' | 'host-unvouched'

export type WorkspaceRunningSession = {
  paneKey: string
  agentType: DashboardCard['agentType']
  title: string
  liveness: RunningSessionLiveness
  hostId: ExecutionHostId
  hostLabel: string
  hostReachability: HostReachability
  /** Canonical Project id; null for folder workspaces and repos no project setup names. */
  projectId: string | null
  worktreeName: string
  lastChangedAt: number
  reveal: {
    worktreeId: string
    tabId: string
    leafId: string | null
    executionHostId: ExecutionHostId
  }
}

const BUCKET_LIVENESS: Record<DashboardCard['bucket'], RunningSessionLiveness> = {
  attention: 'needs-you',
  working: 'working',
  done: 'done',
  idle: 'idle'
}

/**
 * Terminal agents (Claude Code, Hermes, Codex, …) as the live dashboard already sees them — from
 * its snapshot, which keeps the status-decay epoch and connection state — joined to the canonical
 * project and to what Orca has observed about the host (lib/host-reachability). No second
 * tracker: this is a projection of that one.
 */
export function projectRunningSessions(
  cards: readonly DashboardCard[],
  hosts: RunningSessionHostIndex,
  projectIdByRepoId: ReadonlyMap<string, string>
): WorkspaceRunningSession[] {
  return cards
    .map((card) => {
      const hostId = card.executionHostId ?? LOCAL_EXECUTION_HOST_ID
      const host = hosts.get(hostId)
      // A host the registry no longer knows has no reading at all.
      const hostReachability: HostReachability =
        host?.reachability ?? (hostId === LOCAL_EXECUTION_HOST_ID ? 'this-machine' : 'unknown')
      return {
        paneKey: card.paneKey,
        agentType: card.agentType,
        title: card.conversationName || card.task || card.worktreeName,
        liveness: hostVouches(hostReachability) ? BUCKET_LIVENESS[card.bucket] : 'host-unvouched',
        hostId,
        hostLabel: host?.label ?? card.hostLabel ?? hostId,
        hostReachability,
        projectId: projectIdByRepoId.get(card.repoId) ?? null,
        worktreeName: card.worktreeName,
        lastChangedAt: card.stateChangedAt,
        reveal: {
          worktreeId: card.worktreeId,
          tabId: card.tabId,
          leafId: card.leafId,
          executionHostId: hostId
        }
      } satisfies WorkspaceRunningSession
    })
    .sort((a, b) => b.lastChangedAt - a.lastChangedAt)
}
