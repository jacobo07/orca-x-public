import type { StoreApi } from 'zustand'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type {
  LiveAgentSessionPresenceRequest,
  LiveAgentSessionPresenceResponse,
  LiveAgentSessionPresenceWireKind
} from '../../../shared/live-agent-session-presence-types'
import {
  planWorkingSetRestore,
  type WorkingSetRestorePlan
} from '../../../shared/project-working-set-restore-plan'
import type {
  WorkingSetReadResult,
  WorkingSetRestoreEvidence,
  WorkingSetScopeKey
} from '../../../shared/project-working-set-store-types'
import type { ProjectWorkingSetManifest } from '../../../shared/project-working-set-types'
import {
  applyWorkingSetRestorePlan,
  countWorkspaceOpenTabs,
  type WorkingSetApplyResult
} from './project-working-set-apply'
import {
  probeWorkingSetRestoreEvidence,
  readWorkingSet,
  type WorkingSetStoreBridge
} from './project-working-set-client'

/**
 * Restores one sealed working set into its own, empty workspace: read from disk, probe today's
 * facts, ask where each sealed session is live, plan, apply.
 *
 * Planning and applying run in one synchronous turn after the last await, so the emptiness the
 * plan relied on cannot change before the replace. Evidence and presence are gathered before that
 * turn and are advisory: the collision guard re-checks at the moment a session is resumed.
 */

export type WorkingSetRestoreRequest = {
  scope: WorkingSetScopeKey
  workingSetId: string
  /** Profiles this host offers; omitted when the caller has none, which keeps relaunches unknown. */
  launchProfiles?: readonly { id: string }[] | null
}

export type WorkingSetRestoreDeps = {
  store: Pick<StoreApi<AppState>, 'getState'>
  bridge: WorkingSetStoreBridge
  readPresence: (
    request: LiveAgentSessionPresenceRequest
  ) => Promise<LiveAgentSessionPresenceResponse>
  now: () => number
  newId: () => string
}

export type WorkingSetRestoreOutcome =
  /** The working set could not be read; nothing was planned or changed. */
  | { status: 'unreadable'; read: Exclude<WorkingSetReadResult, { status: 'valid' }> }
  | { status: 'planned'; plan: WorkingSetRestorePlan; applied: WorkingSetApplyResult }

function defaultDeps(): WorkingSetRestoreDeps {
  return {
    store: useAppStore,
    bridge: window.api.workingSet,
    readPresence: (request) => window.api.agentStatus.readLivePresence(request),
    now: () => Date.now(),
    newId: () => crypto.randomUUID()
  }
}

async function askPresence(
  manifest: ProjectWorkingSetManifest,
  readPresence: WorkingSetRestoreDeps['readPresence']
): Promise<Record<string, LiveAgentSessionPresenceWireKind>> {
  const answers: Record<string, LiveAgentSessionPresenceWireKind> = {}
  for (const entry of manifest.entries) {
    for (const pane of entry.panes) {
      if (pane.resume.kind !== 'provider-session') {
        continue
      }
      try {
        const response = await readPresence({
          worktreeId: manifest.scope.ownerKey,
          agent: pane.resume.agent,
          providerSession: pane.resume.providerSession
        })
        answers[`${entry.tabId}:${pane.leafId}`] = response.kind
      } catch {
        // Why left out: an unanswered question plans as presence-unknown, never as "nobody holds it".
      }
    }
  }
  return answers
}

async function readAndProbe(request: WorkingSetRestoreRequest, deps: WorkingSetRestoreDeps) {
  const read = await readWorkingSet(request.scope, request.workingSetId, deps.bridge)
  if (read.status !== 'valid') {
    return { kind: 'unreadable', read } as const
  }
  const probed = await probeWorkingSetRestoreEvidence(
    request.scope,
    request.workingSetId,
    deps.bridge
  )
  const presence = await askPresence(read.manifest, deps.readPresence)
  return {
    kind: 'read',
    manifest: read.manifest,
    evidence: probed.status === 'probed' ? probed.evidence : null,
    presence
  } as const
}

function planNow(
  manifest: ProjectWorkingSetManifest,
  facts: {
    evidence: WorkingSetRestoreEvidence | null
    presence: Record<string, LiveAgentSessionPresenceWireKind>
  },
  request: WorkingSetRestoreRequest,
  deps: WorkingSetRestoreDeps
): WorkingSetRestorePlan {
  const { scope } = manifest
  return planWorkingSetRestore(manifest, {
    evidence: facts.evidence,
    launchProfiles: request.launchProfiles ?? null,
    presence: facts.presence,
    target: {
      executionHostId: request.scope.executionHostId,
      ownerKey: request.scope.ownerKey,
      openTabCount: countWorkspaceOpenTabs(deps.store.getState(), scope.ownerKey),
      // Why only local is known available: remote reachability has its own authority.
      hostAvailability:
        parseExecutionHostId(scope.executionHostId)?.kind === 'local' ? 'available' : 'unknown'
    },
    newTabId: deps.newId
  })
}

/** What restoring would do right now, without changing anything. */
export async function previewWorkingSetRestore(
  request: WorkingSetRestoreRequest,
  deps: WorkingSetRestoreDeps = defaultDeps()
): Promise<
  | { status: 'unreadable'; read: Exclude<WorkingSetReadResult, { status: 'valid' }> }
  | { status: 'planned'; plan: WorkingSetRestorePlan }
> {
  const facts = await readAndProbe(request, deps)
  if (facts.kind === 'unreadable') {
    return { status: 'unreadable', read: facts.read }
  }
  return { status: 'planned', plan: planNow(facts.manifest, facts, request, deps) }
}

export async function restoreWorkingSet(
  request: WorkingSetRestoreRequest,
  deps: WorkingSetRestoreDeps = defaultDeps()
): Promise<WorkingSetRestoreOutcome> {
  const facts = await readAndProbe(request, deps)
  if (facts.kind === 'unreadable') {
    return { status: 'unreadable', read: facts.read }
  }
  // No await from here: the plan's view of the workspace is the one the replace acts on.
  const plan = planNow(facts.manifest, facts, request, deps)
  return {
    status: 'planned',
    plan,
    applied: applyWorkingSetRestorePlan(plan, {
      store: deps.store,
      now: deps.now,
      newId: deps.newId
    })
  }
}
