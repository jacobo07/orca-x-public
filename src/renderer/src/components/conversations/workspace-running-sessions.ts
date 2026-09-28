import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { ExecutionHostHealth } from '../../../../shared/execution-host-registry'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'

/** 'host-offline' outranks the agent's own state: a host nobody can reach cannot vouch for it. */
export type RunningSessionLiveness = 'needs-you' | 'working' | 'done' | 'idle' | 'host-offline'

export type WorkspaceRunningSession = {
  paneKey: string
  agentType: DashboardCard['agentType']
  title: string
  liveness: RunningSessionLiveness
  hostId: ExecutionHostId
  hostLabel: string
  /** Canonical Project id; null for folder workspaces and repos no project setup names. */
  projectId: string | null
  worktreeName: string
  lastChangedAt: number
  reveal: { worktreeId: string; tabId: string; leafId: string | null; executionHostId: ExecutionHostId }
}

const UNREACHABLE: ReadonlySet<ExecutionHostHealth> = new Set(['disconnected', 'blocked', 'error'])

const BUCKET_LIVENESS: Record<DashboardCard['bucket'], RunningSessionLiveness> = {
  attention: 'needs-you',
  working: 'working',
  done: 'done',
  idle: 'idle'
}

/**
 * Terminal agents (Claude Code, Hermes, Codex, …) as the live dashboard already sees them — from
 * its snapshot, which keeps the status-decay epoch and connection state — joined to the canonical
 * project and to the host registry's health. No second tracker: this is a projection of that one.
 */
export function projectRunningSessions(
  cards: readonly DashboardCard[],
  hosts: ReadonlyMap<ExecutionHostId, { label: string; health: ExecutionHostHealth }>,
  projectIdByRepoId: ReadonlyMap<string, string>
): WorkspaceRunningSession[] {
  return cards
    .map((card) => {
      const hostId = card.executionHostId ?? LOCAL_EXECUTION_HOST_ID
      const host = hosts.get(hostId)
      const unreachable = host !== undefined && UNREACHABLE.has(host.health)
      return {
        paneKey: card.paneKey,
        agentType: card.agentType,
        title: card.conversationName || card.task || card.worktreeName,
        liveness: unreachable ? 'host-offline' : BUCKET_LIVENESS[card.bucket],
        hostId,
        hostLabel: host?.label ?? card.hostLabel ?? hostId,
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
