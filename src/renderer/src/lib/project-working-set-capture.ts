import type { AppState } from '@/store/types'
import {
  getAgentResumeArgv,
  isResumableTuiAgent,
  normalizeAgentProviderSession
} from '../../../shared/agent-session-resume'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { readProjectWorkingSetManifest } from '../../../shared/project-working-set-schema'
import {
  PROJECT_WORKING_SET_MANIFEST_VERSION,
  type ProjectWorkingSetManifest,
  type WorkingSetEntry,
  type WorkingSetLocation,
  type WorkingSetPane,
  type WorkingSetResumeEvidence
} from '../../../shared/project-working-set-types'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { resolveTerminalTabTitle } from '../../../shared/tab-title-resolution'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../shared/terminal-tab-types'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'

/**
 * Projects one workspace's terminal rail into a working-set manifest.
 *
 * Pure and synchronous over ONE state object: that is the whole coherence guarantee, so nothing
 * here may read the store, await, or consult anything the state does not carry. A composition the
 * state cannot express faithfully is refused with a reason rather than guessed.
 *
 * Every row defaults to restore-on-open and the revival order is empty, so saving never encodes
 * "wake everything" for a later open.
 */

export type WorkingSetCaptureRefusal =
  | 'no-terminals'
  | 'rail-unavailable'
  | 'terminal-outside-rail'
  | 'terminal-in-two-groups'
  | 'invalid-pane-identity'
  | 'execution-host-unresolved'
  | 'owner-key-unrecognized'
  | 'folder-workspace-unknown'
  | 'projection-invalid'

export type WorkingSetCaptureResult =
  | { status: 'captured'; manifest: ProjectWorkingSetManifest }
  | { status: 'not-capturable'; reason: WorkingSetCaptureRefusal; detail: string }

export type WorkingSetCaptureRequest = {
  ownerKey: string
  label: string | null
  workingSetId: string
  createdAt: number
}

class CaptureRefused extends Error {
  constructor(
    readonly reason: WorkingSetCaptureRefusal,
    readonly detail: string
  ) {
    super(reason)
  }
}

function layoutLeafIds(node: TerminalPaneLayoutNode | null, into: string[] = []): string[] {
  if (node?.type === 'leaf') {
    into.push(node.leafId)
  } else if (node) {
    layoutLeafIds(node.first, into)
    layoutLeafIds(node.second, into)
  }
  return into
}

type AgentEvidence = { agent: unknown; session: unknown; ompResumeFilePath?: string | null }

function paneAgentEvidence(state: AppState, paneKey: string): AgentEvidence[] {
  const live = state.agentStatusByPaneKey[paneKey]
  const sleeping = state.sleepingAgentSessionsByPaneKey[paneKey]
  const retained = state.retainedAgentsByPaneKey[paneKey]?.entry
  // Why only this field of the launch config: its siblings carry the agent's environment.
  const liveOmp = state.agentLaunchConfigByPaneKey[paneKey]?.launchConfig.ompResumeFilePath
  const evidence: (AgentEvidence | undefined)[] = [
    live && { agent: live.agentType, session: live.providerSession, ompResumeFilePath: liveOmp },
    sleeping && {
      agent: sleeping.agent,
      session: sleeping.providerSession,
      ompResumeFilePath: sleeping.launchConfig?.ompResumeFilePath
    },
    retained && { agent: retained.agentType, session: retained.providerSession }
  ]
  return evidence.filter((entry): entry is AgentEvidence => entry !== undefined)
}

function resumeEvidence(
  state: AppState,
  tab: TerminalTab,
  leafId: string,
  paneCount: number
): WorkingSetResumeEvidence {
  const evidence = paneAgentEvidence(state, makePaneKey(tab.id, leafId))
  for (const { agent, session, ompResumeFilePath } of evidence) {
    const providerSession = normalizeAgentProviderSession(session)
    const omp = ompResumeFilePath || null
    if (
      isResumableTuiAgent(agent) &&
      providerSession &&
      getAgentResumeArgv(agent, providerSession, omp) !== null
    ) {
      return { kind: 'provider-session', agent, providerSession, ompResumeFilePath: omp }
    }
  }
  // Why the tab's launch agent only for a single pane: a split's other panes did not run it.
  const agent =
    evidence.find((candidate) => candidate.agent)?.agent ??
    (paneCount === 1 ? tab.launchAgent : undefined)
  if (!agent) {
    return { kind: 'absent', reason: 'not-an-agent' }
  }
  return {
    kind: 'absent',
    reason: isResumableTuiAgent(agent) ? 'no-provider-session-captured' : 'agent-not-resumable'
  }
}

function projectPanes(
  state: AppState,
  tab: TerminalTab,
  layout: TerminalLayoutSnapshot | undefined
): { panes: WorkingSetPane[]; activeLeafId: string | null } {
  const leafIds = layoutLeafIds(layout?.root ?? null)
  const invalid = leafIds.find((leafId) => !isTerminalLeafId(leafId))
  if (invalid !== undefined) {
    throw new CaptureRefused('invalid-pane-identity', tab.id)
  }
  const panes = leafIds.map((leafId) => ({
    leafId,
    title: layout?.titlesByLeafId?.[leafId] ?? null,
    scrollbackRef: layout?.scrollbackRefsByLeafId?.[leafId] ?? null,
    resume: resumeEvidence(state, tab, leafId, leafIds.length)
  }))
  const activeLeafId =
    layout?.activeLeafId && leafIds.includes(layout.activeLeafId) ? layout.activeLeafId : null
  return { panes, activeLeafId }
}

function projectEntry(state: AppState, tab: TerminalTab): WorkingSetEntry {
  const { panes, activeLeafId } = projectPanes(state, tab, state.terminalLayoutsByTabId[tab.id])
  return {
    tabId: tab.id,
    label: resolveTerminalTabTitle(tab, state.settings?.tabAutoGenerateTitle === true, tab.title),
    color: tab.color,
    isPinned: tab.isPinned === true,
    launch: {
      launchProfileId: tab.launchProfileId ?? null,
      launchAgent: tab.launchAgent ?? null,
      shellOverride: tab.shellOverride ?? null
    },
    startupCwd: tab.startupCwd ?? null,
    restorePolicy: 'restore-on-open',
    activeLeafId,
    panes
  }
}

function projectRail(state: AppState, ownerKey: string, tabIds: ReadonlySet<string>): string[][] {
  const groups = state.groupsByWorktree[ownerKey] ?? []
  if (groups.length === 0) {
    throw new CaptureRefused('rail-unavailable', ownerKey)
  }
  const entityByUnifiedId = new Map(
    (state.unifiedTabsByWorktree[ownerKey] ?? [])
      .filter((tab) => tab.contentType === 'terminal')
      .map((tab) => [tab.id, tab.entityId])
  )
  const placed = new Set<string>()
  const rail: string[][] = []
  for (const group of groups) {
    const ids: string[] = []
    for (const unifiedId of group.tabOrder) {
      const tabId = entityByUnifiedId.get(unifiedId)
      if (tabId === undefined || !tabIds.has(tabId)) {
        continue
      }
      if (placed.has(tabId)) {
        throw new CaptureRefused('terminal-in-two-groups', tabId)
      }
      placed.add(tabId)
      ids.push(tabId)
    }
    if (ids.length > 0) {
      rail.push(ids)
    }
  }
  const unplaced = [...tabIds].find((tabId) => !placed.has(tabId))
  if (unplaced !== undefined) {
    throw new CaptureRefused('terminal-outside-rail', unplaced)
  }
  return rail
}

function projectLocation(
  state: AppState,
  ownerKey: string,
  hostId: ExecutionHostId
): WorkingSetLocation {
  const workspaceKey = parseWorkspaceKey(ownerKey)
  if (workspaceKey?.type === 'folder') {
    const candidates = (state.folderWorkspaces ?? []).filter(
      (folder) => folder.id === workspaceKey.folderWorkspaceId
    )
    const folder =
      candidates.length === 1
        ? candidates[0]
        : candidates.find((candidate) => candidate.executionHostId === hostId)
    if (!folder) {
      throw new CaptureRefused('folder-workspace-unknown', workspaceKey.folderWorkspaceId)
    }
    return {
      kind: 'folder-workspace',
      folderWorkspaceId: folder.id,
      folderPath: folder.folderPath
    }
  }
  const parsed = splitWorktreeIdForFilesystem(
    workspaceKey?.type === 'worktree' ? workspaceKey.worktreeId : ownerKey
  )
  if (!parsed) {
    throw new CaptureRefused('owner-key-unrecognized', ownerKey)
  }
  return { kind: 'repo-worktree', repoId: parsed.repoId, worktreePath: parsed.worktreePath }
}

export function projectWorkingSetFromState(
  state: AppState,
  request: WorkingSetCaptureRequest
): WorkingSetCaptureResult {
  const { ownerKey } = request
  try {
    const tabs = state.tabsByWorktree[ownerKey] ?? []
    if (tabs.length === 0) {
      throw new CaptureRefused('no-terminals', ownerKey)
    }
    const hostId = getExecutionHostIdForWorktree(state, ownerKey)
    if (hostId.includes('unresolved-owner')) {
      throw new CaptureRefused('execution-host-unresolved', ownerKey)
    }
    const location = projectLocation(state, ownerKey, hostId)
    const tabIds = new Set(tabs.map((tab) => tab.id))
    const railGroups = projectRail(state, ownerKey, tabIds)
    const active = state.activeTabIdByWorktree[ownerKey] ?? null
    const manifest: ProjectWorkingSetManifest = {
      manifestVersion: PROJECT_WORKING_SET_MANIFEST_VERSION,
      workingSetId: request.workingSetId,
      label: request.label,
      createdAt: request.createdAt,
      scope: { executionHostId: hostId, ownerKey, location },
      railGroups,
      revivalOrder: [],
      activeTabId: active !== null && tabIds.has(active) ? active : null,
      entries: tabs.map((tab) => projectEntry(state, tab))
    }
    // Same reader main applies; a refusal here saves a round trip and names the field.
    const checked = readProjectWorkingSetManifest(manifest)
    if (checked.status !== 'valid') {
      const detail =
        checked.status === 'corrupt'
          ? `${checked.reason}: ${checked.detail}`
          : `version ${checked.manifestVersion}`
      return { status: 'not-capturable', reason: 'projection-invalid', detail }
    }
    return { status: 'captured', manifest }
  } catch (error) {
    if (error instanceof CaptureRefused) {
      return { status: 'not-capturable', reason: error.reason, detail: error.detail }
    }
    throw error
  }
}
