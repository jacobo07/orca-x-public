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
  planContinueOnHost,
  translateWorkingSetToHost,
  type ContinuePane,
  type HostTranslationRefusal,
  type HostTranslationRequest
} from '../../../shared/project-working-set-host-translation'
import type { ProjectHostSetup } from '../../../shared/project-types'
import { hostAvailabilityFromSshState } from './project-working-set-continue-target'
import {
  planWorkingSetRestore,
  type RestorePlanTarget,
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
  continueCwdByPaneKey,
  continueEvidenceOnTarget
} from '../../../shared/project-working-set-continue-evidence'
import {
  probeWorkingSetRestoreEvidence,
  readWorkingSet,
  transferContinueSessions,
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

/** The same set continued onto another host's setup; `scope` stays the source it was sealed under. */
export type WorkingSetContinueRequest = WorkingSetRestoreRequest & {
  continueOn: HostTranslationRequest
}

export type WorkingSetRestoreDeps = {
  store: Pick<StoreApi<AppState>, 'getState'>
  bridge: WorkingSetStoreBridge
  readPresence: (
    request: LiveAgentSessionPresenceRequest
  ) => Promise<LiveAgentSessionPresenceResponse>
  now: () => number
  newId: () => string
  /** Reachability of a continue target; absent reads as unknown, never as available. */
  hostAvailability?: (target: ProjectHostSetup) => RestorePlanTarget['hostAvailability']
}

export type WorkingSetRestoreOutcome =
  /** The working set could not be read; nothing was planned or changed. */
  | { status: 'unreadable'; read: Exclude<WorkingSetReadResult, { status: 'valid' }> }
  | { status: 'planned'; plan: WorkingSetRestorePlan; applied: WorkingSetApplyResult }

export type ContinueRestoreOutcome =
  | Extract<WorkingSetRestoreOutcome, { status: 'unreadable' }>
  /** Translation said no; nothing was probed, planned or changed. */
  | { status: 'continue-refused'; reason: HostTranslationRefusal }
  | {
      status: 'planned'
      plan: WorkingSetRestorePlan
      applied: WorkingSetApplyResult
      /** What opening each restored row will do on the target host; restore opens nothing. */
      panes: ContinuePane[]
    }

function defaultDeps(): WorkingSetRestoreDeps {
  return {
    store: useAppStore,
    bridge: window.api.workingSet,
    readPresence: (request) => window.api.agentStatus.readLivePresence(request),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    hostAvailability: (target) =>
      hostAvailabilityFromSshState(target, useAppStore.getState().sshConnectionStates)
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

async function gatherFacts(
  request: WorkingSetRestoreRequest,
  manifest: ProjectWorkingSetManifest,
  presenceManifest: ProjectWorkingSetManifest,
  deps: WorkingSetRestoreDeps
) {
  // Why the source scope: the sealed copies and their evidence live under the scope it was saved with.
  const probed = await probeWorkingSetRestoreEvidence(
    request.scope,
    request.workingSetId,
    deps.bridge
  )
  // Why a separate manifest: the question is who holds the session on the host a continue moves to.
  const presence = await askPresence(presenceManifest, deps.readPresence)
  return {
    manifest,
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
  const read = await readWorkingSet(request.scope, request.workingSetId, deps.bridge)
  if (read.status !== 'valid') {
    return { status: 'unreadable', read }
  }
  const facts = await gatherFacts(request, read.manifest, read.manifest, deps)
  return { status: 'planned', plan: planNow(facts.manifest, facts, request, deps) }
}

function planContinueNow(
  manifest: ProjectWorkingSetManifest,
  continueOn: HostTranslationRequest,
  hostAvailability: RestorePlanTarget['hostAvailability'],
  facts: {
    evidence: WorkingSetRestoreEvidence | null
    presence: Record<string, LiveAgentSessionPresenceWireKind>
  },
  request: WorkingSetRestoreRequest,
  deps: WorkingSetRestoreDeps
) {
  return planContinueOnHost(manifest, continueOn, {
    evidence: facts.evidence,
    launchProfiles: request.launchProfiles ?? null,
    presence: facts.presence,
    target: {
      openTabCount: countWorkspaceOpenTabs(deps.store.getState(), continueOn.targetOwnerKey),
      hostAvailability
    },
    newTabId: deps.newId
  })
}

export async function restoreWorkingSet(
  request: WorkingSetContinueRequest,
  deps?: WorkingSetRestoreDeps
): Promise<ContinueRestoreOutcome>
export async function restoreWorkingSet(
  request: WorkingSetRestoreRequest,
  deps?: WorkingSetRestoreDeps
): Promise<WorkingSetRestoreOutcome>
export async function restoreWorkingSet(
  request: WorkingSetRestoreRequest | WorkingSetContinueRequest,
  deps: WorkingSetRestoreDeps = defaultDeps()
): Promise<WorkingSetRestoreOutcome | ContinueRestoreOutcome> {
  const continueOn = 'continueOn' in request ? request.continueOn : undefined
  const read = await readWorkingSet(request.scope, request.workingSetId, deps.bridge)
  if (read.status !== 'valid') {
    return { status: 'unreadable', read }
  }
  const translated = continueOn ? translateWorkingSetToHost(read.manifest, continueOn) : null
  if (translated?.kind === 'refused') {
    return { status: 'continue-refused', reason: translated.reason }
  }
  const facts = await gatherFacts(
    request,
    read.manifest,
    translated?.manifest ?? read.manifest,
    deps
  )
  if (continueOn) {
    const availabilityNow = (): RestorePlanTarget['hostAvailability'] =>
      continueOn.targetSetup
        ? (deps.hostAvailability?.(continueOn.targetSetup) ?? 'unknown')
        : 'unknown'
    const onTarget = (transferred: Parameters<typeof continueEvidenceOnTarget>[1]) => ({
      ...facts,
      evidence: continueEvidenceOnTarget(facts.evidence, transferred)
    })
    // Why a plan before the copy: a continue that would be refused copies nothing.
    let hostAvailability = availabilityNow()
    let continued = planContinueNow(
      facts.manifest,
      continueOn,
      hostAvailability,
      onTarget(null),
      request,
      deps
    )
    const sshTarget = parseExecutionHostId(continueOn.targetSetup?.hostId)
    if (
      continued.kind === 'planned' &&
      hostAvailability === 'available' &&
      continued.plan.blockers.length === 0 &&
      sshTarget?.kind === 'ssh' &&
      translated?.kind === 'translated'
    ) {
      const cwdByPaneKey = continueCwdByPaneKey(translated.manifest)
      if (Object.keys(cwdByPaneKey).length > 0) {
        const transfer = await transferContinueSessions(
          {
            scope: request.scope,
            workingSetId: request.workingSetId,
            connectionId: sshTarget.targetId,
            cwdByPaneKey
          },
          deps.bridge
        )
        hostAvailability = availabilityNow()
        continued = planContinueNow(
          facts.manifest,
          continueOn,
          hostAvailability,
          onTarget(transfer.status === 'transferred' ? transfer.panes : null),
          request,
          deps
        )
      }
    }
    // No await from here: the plan's view of the workspace is the one the replace acts on.
    if (continued.kind === 'refused') {
      return { status: 'continue-refused', reason: continued.reason }
    }
    // Why refuse on unknown too: the planner only blocks a host known down, and nothing is promised on a guess.
    const applied: WorkingSetApplyResult =
      hostAvailability === 'available'
        ? applyWorkingSetRestorePlan(continued.plan, {
            store: deps.store,
            now: deps.now,
            newId: deps.newId
          })
        : {
            status: 'refused',
            blockers: continued.plan.blockers.includes('host-unavailable')
              ? continued.plan.blockers
              : [...continued.plan.blockers, 'host-unavailable']
          }
    return { status: 'planned', plan: continued.plan, panes: continued.panes, applied }
  }
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
