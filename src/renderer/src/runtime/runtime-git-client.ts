/* eslint-disable max-lines -- Why: this module mirrors the git preload API with
runtime-aware routing so source-control callers have one typed boundary instead
of reimplementing local-vs-environment branching per operation. */
import type {
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitDiffResult
} from '../../../shared/git-diff-compare-types'
import type { GitForkSyncExpectedUpstream, GitForkSyncResult } from '../../../shared/git-fork-sync'
import type {
  GitConflictOperation,
  GitStagingArea,
  GitStatusResult,
  GitUpstreamStatus
} from '../../../shared/git-status-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { GitPushTarget } from '../../../shared/worktree/types'
import type {
  CommitMessageAgentCapability,
  CommitMessageModelCapability
} from '../../../shared/commit-message-agent-spec'
import type { HostedReviewProvider } from '../../../shared/hosted-review'
import type { ResolvedSourceControlAiGenerationParams } from '../../../shared/source-control-ai'
import { getCommitMessageModelDiscoveryHostKeyForScope } from '../../../shared/commit-message-host-key'
import type { GitHistoryOptions, GitHistoryResult } from '../../../shared/git-history'
import { getRepoIdFromWorktreeId, splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import {
  GIT_BULK_DISCARD_STALE_STATE_RUNTIME_CAPABILITY,
  GIT_DISCARD_STALE_STATE_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { DiscardObservedStateRequiredError } from '../../../shared/stale-worktree-state'
import type { DiscardPrecondition } from '../../../shared/worktree-content-identity'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  getActiveRuntimeTarget
} from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

/**
 * Shown when a discard cannot be made safe against the host on the other end.
 *
 * Not a stale-state conflict, and it must never borrow that wording: nothing changed and nothing was
 * destroyed. The host simply predates the check, so there is one action that helps and it is not
 * "look at your file again".
 */
export const DISCARD_HOST_CANNOT_CHECK_MESSAGE =
  'This Orca host is too old to check whether the file changed since you looked, so nothing was discarded. Update the host and try again.'

export type RuntimeGenerateCommitMessageResult =
  | { success: true; message: string; agentLabel?: string }
  | { success: false; error: string; canceled?: boolean }

export type RuntimeGeneratePullRequestFieldsResult =
  | {
      success: true
      fields: { base: string; title: string; body: string; draft: boolean }
      agentLabel?: string
      branchChangedByPreparation?: boolean
    }
  | { success: false; error: string; canceled?: boolean; branchChangedByPreparation?: boolean }

export type RuntimePullRequestGenerationInput = {
  base: string
  title: string
  body: string
  draft: boolean
  provider?: HostedReviewProvider
  useTemplate?: boolean
}

type RuntimeGitSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> &
  Partial<Pick<GlobalSettings, 'commitMessageAi' | 'sourceControlAi' | 'agentCmdOverrides'>>

type RuntimeDiscoverCommitMessageModelsResult =
  | {
      success: true
      capability: CommitMessageAgentCapability
      models: CommitMessageModelCapability[]
      defaultModelId: string
      /** Missing only when an older remote runtime produced the response. */
      catalogOrigin?: 'probe' | 'spec'
    }
  | { success: false; error: string }

export type RuntimeGitContext = {
  settings: RuntimeGitSettings | null | undefined
  worktreeId: string | null | undefined
  worktreePath: string
  connectionId?: string
}

// Why: folder-workspace instance IDs carry a synthetic `::workspace:<uuid>`
// suffix for identity, and store placeholders surface that suffix on
// `worktree.path`. Every local Git op runs `worktreePath` as a subprocess cwd,
// so resolve the real filesystem path here or Git spawns against a nonexistent
// directory (ENOENT). Ordinary worktrees keep their parsed path unchanged.
function resolveLocalWorktreePath(context: RuntimeGitContext): string {
  return context.worktreeId
    ? (splitWorktreeIdForFilesystem(context.worktreeId)?.worktreePath ?? context.worktreePath)
    : context.worktreePath
}

export type RuntimeGenerateCommitMessageOverrides = {
  sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
  sourceControlAi?: GlobalSettings['sourceControlAi']
  agentCmdOverrides?: GlobalSettings['agentCmdOverrides']
}

export type RuntimeGeneratePullRequestFieldsOverrides = RuntimeGenerateCommitMessageOverrides

function getRuntimeCommitMessageSettings(
  settings: RuntimeGitSettings | null | undefined,
  connectionId?: string
): Partial<Pick<GlobalSettings, 'commitMessageAi' | 'sourceControlAi' | 'agentCmdOverrides'>> & {
  commitMessageDiscoveryHostKey?: string
} {
  if (!settings) {
    return {}
  }
  const scope = getRuntimeGitScope(settings, connectionId)
  return {
    ...(settings.commitMessageAi !== undefined
      ? { commitMessageAi: settings.commitMessageAi }
      : {}),
    ...(settings.sourceControlAi !== undefined
      ? { sourceControlAi: settings.sourceControlAi }
      : {}),
    ...(settings.agentCmdOverrides !== undefined
      ? { agentCmdOverrides: settings.agentCmdOverrides }
      : {}),
    commitMessageDiscoveryHostKey: getCommitMessageModelDiscoveryHostKeyForScope(scope)
  }
}

export function getRuntimeGitScope(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  connectionId: string | null | undefined
): string | null | undefined {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment' ? `runtime:${target.environmentId}` : connectionId
}

export async function getRuntimeGitStatus(
  context: RuntimeGitContext,
  options?: {
    includeIgnored?: boolean
    bypassEffectiveUpstreamNegativeCache?: boolean
    reuseLineStats?: boolean
    branchLineTotalMergeBase?: string
    /** Stamp each row with the identity of its working-tree bytes, so a surface that can later ask to
     *  discard one is able to say what it observed. Only destructive surfaces should ask: the cost is
     *  a read per changed file, unmeasurable against git's own variance below about a hundred of them
     *  and roughly 3ms each above that. */
    worktreeContentIdentity?: boolean
    signal?: AbortSignal
  }
): Promise<GitStatusResult> {
  const target = getActiveRuntimeTarget(context.settings)
  const includeIgnoredArgs = options?.includeIgnored ? { includeIgnored: true } : {}
  const upstreamCacheBypassArgs = options?.bypassEffectiveUpstreamNegativeCache
    ? { bypassEffectiveUpstreamNegativeCache: true }
    : {}
  const lineStatsReuseArgs = options?.reuseLineStats ? { reuseLineStats: true } : {}
  const branchLineTotalArgs = options?.branchLineTotalMergeBase
    ? { branchLineTotalMergeBase: options.branchLineTotalMergeBase }
    : {}
  const contentIdentityArgs = options?.worktreeContentIdentity
    ? { worktreeContentIdentity: true }
    : {}
  if (target.kind === 'local' || !context.worktreeId) {
    return callLocalGitStatus(
      {
        worktreePath: resolveLocalWorktreePath(context),
        connectionId: context.connectionId,
        ...includeIgnoredArgs,
        ...upstreamCacheBypassArgs,
        ...lineStatsReuseArgs,
        ...branchLineTotalArgs,
        ...contentIdentityArgs
      },
      options?.signal
    )
  }
  return callRuntimeRpc<GitStatusResult>(
    target,
    'git.status',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...includeIgnoredArgs,
      ...upstreamCacheBypassArgs,
      ...lineStatsReuseArgs,
      ...branchLineTotalArgs,
      ...contentIdentityArgs
    },
    {
      timeoutMs: 15_000,
      // Why: an abort signal forces the dedicated per-request subscription
      // socket (one WebSocket + E2EE handshake per request). The safety
      // refresh is the idle steady state, so it stays on the pooled call
      // transport: its stale result is rejected by the caller's liveness
      // guard and the 15s timeout bounds it. Activity refreshes keep the
      // abortable transport so pause/host switches cancel real remote work.
      ...(options?.reuseLineStats ? {} : { signal: options?.signal })
    }
  )
}

export async function setRuntimeGitStatusUpstreamRefWatch(
  context: RuntimeGitContext,
  args: { executionHostId: string; branch?: string; upstreamName?: string }
): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'local' || !context.worktreeId) {
    return
  }
  await window.api.git.setStatusUpstreamRefWatch({
    worktreeId: context.worktreeId,
    worktreePath: resolveLocalWorktreePath(context),
    executionHostId: args.executionHostId,
    ...(context.connectionId ? { connectionId: context.connectionId } : {}),
    ...(args.branch ? { branch: args.branch } : {}),
    ...(args.upstreamName ? { upstreamName: args.upstreamName } : {})
  })
}

let nextGitStatusRequestToken = 0

function createGitStatusAbortError(): Error {
  const error = new Error('Git status request aborted')
  error.name = 'AbortError'
  return error
}

async function callLocalGitStatus(
  args: Parameters<Window['api']['git']['status']>[0],
  signal?: AbortSignal
): Promise<GitStatusResult> {
  if (!signal) {
    return window.api.git.status(args)
  }
  if (signal.aborted) {
    throw createGitStatusAbortError()
  }
  const requestToken = `git-status-${Date.now()}-${++nextGitStatusRequestToken}`
  const cancel = (): void => {
    void window.api.git.cancelStatus({ requestToken }).catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const status = await window.api.git.status({ ...args, requestToken })
    // Why: cancel is best-effort; a scan that finished after abort must still
    // reject so callers never treat a cancelled request as a fresh result.
    if (signal.aborted) {
      throw createGitStatusAbortError()
    }
    return status
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

export async function getRuntimeGitSubmoduleStatus(
  context: RuntimeGitContext,
  submodulePath: string,
  area: GitStagingArea = 'unstaged'
): Promise<GitStatusResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.submoduleStatus({
      worktreePath: resolveLocalWorktreePath(context),
      submodulePath,
      connectionId: context.connectionId,
      area
    })
  }
  return callRuntimeRpc<GitStatusResult>(
    target,
    'git.submoduleStatus',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      submodulePath,
      area
    },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitIgnoredPaths(
  context: RuntimeGitContext,
  paths: string[]
): Promise<string[]> {
  const target = getActiveRuntimeTarget(context.settings)
  if (paths.length === 0) {
    return []
  }
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.checkIgnored({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      paths
    })
  }
  return callRuntimeRpc<string[]>(
    target,
    'git.checkIgnored',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), paths },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitHistory(
  context: RuntimeGitContext,
  options: GitHistoryOptions = {}
): Promise<GitHistoryResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.history({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      ...options
    })
  }
  return callRuntimeRpc<GitHistoryResult>(
    target,
    'git.history',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), ...options },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitConflictOperation(
  context: RuntimeGitContext
): Promise<GitConflictOperation> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.conflictOperation({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitConflictOperation>(
    target,
    'git.conflictOperation',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId) },
    { timeoutMs: 15_000 }
  )
}

export async function abortRuntimeGitMerge(context: RuntimeGitContext): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.abortMerge({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.abortMerge',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId) },
    { timeoutMs: 30_000 }
  )
}

export async function abortRuntimeGitRebase(context: RuntimeGitContext): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.abortRebase({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.abortRebase',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId) },
    { timeoutMs: 30_000 }
  )
}

export async function getRuntimeGitDiff(
  context: RuntimeGitContext,
  args: { filePath: string; staged: boolean; compareAgainstHead?: boolean }
): Promise<GitDiffResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.diff({
      worktreePath: resolveLocalWorktreePath(context),
      filePath: args.filePath,
      staged: args.staged,
      compareAgainstHead: args.compareAgainstHead,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitDiffResult>(
    target,
    'git.diff',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), ...args },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitBranchCompare(
  context: RuntimeGitContext,
  baseRef: string
): Promise<GitBranchCompareResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.branchCompare({
      worktreePath: resolveLocalWorktreePath(context),
      baseRef,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitBranchCompareResult>(
    target,
    'git.branchCompare',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), baseRef },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitCommitCompare(
  context: RuntimeGitContext,
  commitId: string
): Promise<GitCommitCompareResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.commitCompare({
      worktreePath: resolveLocalWorktreePath(context),
      commitId,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitCommitCompareResult>(
    target,
    'git.commitCompare',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), commitId },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitUpstreamStatus(
  context: RuntimeGitContext,
  pushTarget?: GitPushTarget
): Promise<GitUpstreamStatus> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.upstreamStatus({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      ...(pushTarget ? { pushTarget } : {})
    })
  }
  return callRuntimeRpc<GitUpstreamStatus>(
    target,
    'git.upstreamStatus',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...(pushTarget ? { pushTarget } : {})
    },
    { timeoutMs: 15_000 }
  )
}

export async function fetchRuntimeGit(
  context: RuntimeGitContext,
  pushTarget?: GitPushTarget
): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.fetch({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      ...(pushTarget ? { pushTarget } : {})
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.fetch',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...(pushTarget ? { pushTarget } : {})
    },
    { timeoutMs: 30_000 }
  )
}

export async function syncRuntimeGitForkDefaultBranch(
  context: RuntimeGitContext,
  expectedUpstream: GitForkSyncExpectedUpstream
): Promise<GitForkSyncResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.syncFork({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      expectedUpstream
    })
  }
  return callRuntimeRpc<GitForkSyncResult>(
    target,
    'git.forkSync',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      expectedUpstream
    },
    { timeoutMs: 60_000 }
  )
}

export async function pullRuntimeGit(
  context: RuntimeGitContext,
  pushTarget?: GitPushTarget
): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.pull({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      ...(pushTarget ? { pushTarget } : {})
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.pull',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...(pushTarget ? { pushTarget } : {})
    },
    { timeoutMs: 30_000 }
  )
}

export async function fastForwardRuntimeGit(
  context: RuntimeGitContext,
  pushTarget?: GitPushTarget
): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.fastForward({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      ...(pushTarget ? { pushTarget } : {})
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.fastForward',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...(pushTarget ? { pushTarget } : {})
    },
    { timeoutMs: 30_000 }
  )
}

export async function rebaseRuntimeGitFromBase(
  context: RuntimeGitContext,
  baseRef: string
): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.rebaseFromBase({
      worktreePath: resolveLocalWorktreePath(context),
      baseRef,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.rebaseFromBase',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), baseRef },
    { timeoutMs: 30_000 }
  )
}

export async function pushRuntimeGit(
  context: RuntimeGitContext,
  args: { publish?: boolean; pushTarget?: GitPushTarget; forceWithLease?: boolean } = {}
): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.push({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      ...(args.publish !== undefined ? { publish: args.publish } : {}),
      ...(args.pushTarget !== undefined ? { pushTarget: args.pushTarget } : {}),
      ...(args.forceWithLease !== undefined ? { forceWithLease: args.forceWithLease } : {})
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.push',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...(args.publish !== undefined ? { publish: args.publish } : {}),
      ...(args.pushTarget !== undefined ? { pushTarget: args.pushTarget } : {}),
      ...(args.forceWithLease !== undefined ? { forceWithLease: args.forceWithLease } : {})
    },
    { timeoutMs: 30_000 }
  )
}

export async function getRuntimeGitBranchDiff(
  context: RuntimeGitContext,
  args: {
    compare: { baseRef: string; baseOid: string; headOid: string; mergeBase: string }
    filePath: string
    oldPath?: string
  }
): Promise<GitDiffResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.branchDiff({
      worktreePath: resolveLocalWorktreePath(context),
      compare: args.compare,
      filePath: args.filePath,
      oldPath: args.oldPath,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitDiffResult>(
    target,
    'git.branchDiff',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), ...args },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitCommitDiff(
  context: RuntimeGitContext,
  args: {
    commitOid: string
    parentOid?: string | null
    filePath: string
    oldPath?: string
  }
): Promise<GitDiffResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.commitDiff({
      worktreePath: resolveLocalWorktreePath(context),
      commitOid: args.commitOid,
      parentOid: args.parentOid,
      filePath: args.filePath,
      oldPath: args.oldPath,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitDiffResult>(
    target,
    'git.commitDiff',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), ...args },
    { timeoutMs: 15_000 }
  )
}

export async function commitRuntimeGit(
  context: RuntimeGitContext,
  message: string
): Promise<{ success: boolean; error?: string }> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.commit({
      worktreePath: resolveLocalWorktreePath(context),
      message,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<{ success: boolean; error?: string }>(
    target,
    'git.commit',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), message },
    { timeoutMs: 30_000 }
  )
}

export async function generateRuntimeCommitMessage(
  context: RuntimeGitContext,
  overrides?: RuntimeGenerateCommitMessageOverrides
): Promise<RuntimeGenerateCommitMessageResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.generateCommitMessage({
      worktreePath: resolveLocalWorktreePath(context),
      // Why: raw id — the `::workspace:<uuid>` suffix is part of the worktree meta key.
      ...(context.worktreeId ? { worktreeId: context.worktreeId } : {}),
      repoId: context.worktreeId ? getRepoIdFromWorktreeId(context.worktreeId) : undefined,
      connectionId: context.connectionId,
      ...(overrides?.sourceControlAiResolvedParams
        ? { sourceControlAiResolvedParams: overrides.sourceControlAiResolvedParams }
        : {}),
      ...(overrides?.sourceControlAi ? { sourceControlAi: overrides.sourceControlAi } : {}),
      ...(overrides?.agentCmdOverrides ? { agentCmdOverrides: overrides.agentCmdOverrides } : {})
    }) as Promise<RuntimeGenerateCommitMessageResult>
  }
  return callRuntimeRpc<RuntimeGenerateCommitMessageResult>(
    target,
    'git.generateCommitMessage',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...getRuntimeCommitMessageSettings(context.settings, context.connectionId),
      ...(overrides?.sourceControlAiResolvedParams
        ? { sourceControlAiResolvedParams: overrides.sourceControlAiResolvedParams }
        : {}),
      ...(overrides?.sourceControlAi ? { sourceControlAi: overrides.sourceControlAi } : {}),
      ...(overrides?.agentCmdOverrides ? { agentCmdOverrides: overrides.agentCmdOverrides } : {})
    },
    { timeoutMs: 75_000 }
  )
}

export async function discoverRuntimeCommitMessageModels(
  context: RuntimeGitContext,
  agentId: string
): Promise<RuntimeDiscoverCommitMessageModelsResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.discoverCommitMessageModels({
      agentId,
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId
    }) as Promise<RuntimeDiscoverCommitMessageModelsResult>
  }
  return callRuntimeRpc<RuntimeDiscoverCommitMessageModelsResult>(
    target,
    'git.discoverCommitMessageModels',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      agentId,
      ...(context.settings?.agentCmdOverrides
        ? { agentCmdOverrides: context.settings.agentCmdOverrides }
        : {})
    },
    { timeoutMs: 75_000 }
  )
}

export async function cancelRuntimeGenerateCommitMessage(
  context: RuntimeGitContext
): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.cancelGenerateCommitMessage({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.cancelGenerateCommitMessage',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId) },
    { timeoutMs: 5_000 }
  )
}

export async function generateRuntimePullRequestFields(
  context: RuntimeGitContext,
  input: RuntimePullRequestGenerationInput,
  overrides?: RuntimeGeneratePullRequestFieldsOverrides
): Promise<RuntimeGeneratePullRequestFieldsResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.generatePullRequestFields({
      worktreePath: resolveLocalWorktreePath(context),
      // Why: raw id — the `::workspace:<uuid>` suffix is part of the worktree meta key.
      ...(context.worktreeId ? { worktreeId: context.worktreeId } : {}),
      repoId: context.worktreeId ? getRepoIdFromWorktreeId(context.worktreeId) : undefined,
      connectionId: context.connectionId,
      ...input,
      ...(overrides?.sourceControlAiResolvedParams
        ? { sourceControlAiResolvedParams: overrides.sourceControlAiResolvedParams }
        : {}),
      ...(overrides?.sourceControlAi ? { sourceControlAi: overrides.sourceControlAi } : {}),
      ...(overrides?.agentCmdOverrides ? { agentCmdOverrides: overrides.agentCmdOverrides } : {})
    }) as Promise<RuntimeGeneratePullRequestFieldsResult>
  }
  return callRuntimeRpc<RuntimeGeneratePullRequestFieldsResult>(
    target,
    'git.generatePullRequestFields',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...input,
      ...getRuntimeCommitMessageSettings(context.settings, context.connectionId),
      ...(overrides?.sourceControlAiResolvedParams
        ? { sourceControlAiResolvedParams: overrides.sourceControlAiResolvedParams }
        : {}),
      ...(overrides?.sourceControlAi ? { sourceControlAi: overrides.sourceControlAi } : {}),
      ...(overrides?.agentCmdOverrides ? { agentCmdOverrides: overrides.agentCmdOverrides } : {})
    },
    { timeoutMs: 75_000 }
  )
}

export async function cancelRuntimeGeneratePullRequestFields(
  context: RuntimeGitContext
): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.cancelGeneratePullRequestFields({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.cancelGeneratePullRequestFields',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId) },
    { timeoutMs: 5_000 }
  )
}

export async function stageRuntimeGitPath(
  context: RuntimeGitContext,
  filePath: string
): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.stage({
      worktreePath: resolveLocalWorktreePath(context),
      filePath,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.stage',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), filePath },
    { timeoutMs: 15_000 }
  )
}

export async function bulkStageRuntimeGitPaths(
  context: RuntimeGitContext,
  filePaths: string[]
): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.bulkStage({
      worktreePath: resolveLocalWorktreePath(context),
      filePaths,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.bulkStage',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), filePaths },
    { timeoutMs: 15_000 }
  )
}

export async function unstageRuntimeGitPath(
  context: RuntimeGitContext,
  filePath: string
): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.unstage({
      worktreePath: resolveLocalWorktreePath(context),
      filePath,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.unstage',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), filePath },
    { timeoutMs: 15_000 }
  )
}

export async function bulkUnstageRuntimeGitPaths(
  context: RuntimeGitContext,
  filePaths: string[]
): Promise<void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.bulkUnstage({
      worktreePath: resolveLocalWorktreePath(context),
      filePaths,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.bulkUnstage',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), filePaths },
    { timeoutMs: 15_000 }
  )
}

/**
 * Discard many paths, stating the working-tree content the caller observed for each.
 *
 * `observed` must cover every path, for the same reason the single-path call refuses an undescribed one:
 * authorizing a subset would perform the unprotected operation on the remainder, inside the protected
 * one. The host reports which paths it destroyed and which it kept back, and that answer is returned
 * unchanged -- a caller that substituted the requested list would be claiming something no host said.
 */
export async function bulkDiscardRuntimeGitPaths(
  context: RuntimeGitContext,
  filePaths: string[],
  observed: ReadonlyMap<string, string>
): Promise<{ discarded: string[]; refused: string[] }> {
  const undescribed = filePaths.filter((filePath) => !observed.has(filePath))
  if (undescribed.length > 0) {
    throw new DiscardObservedStateRequiredError(undescribed.join(', '))
  }
  // A list rather than a Map, because a Map does not survive either serialization boundary below.
  const targets = filePaths.map((filePath) => ({
    filePath,
    expectedContent: observed.get(filePath) as string
  }))
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.bulkDiscard({
      worktreePath: resolveLocalWorktreePath(context),
      filePaths,
      connectionId: context.connectionId,
      observed: targets
    })
  }
  // Fail-closed before the request, not after: an older runtime parses the field, ignores it, destroys
  // everything and reports success. Its own capability, because a host can enforce the single-path check
  // and know nothing about this one.
  await assertRuntimeEnvironmentCapability(
    target.environmentId,
    GIT_BULK_DISCARD_STALE_STATE_RUNTIME_CAPABILITY,
    DISCARD_HOST_CANNOT_CHECK_MESSAGE
  )
  return callRuntimeRpc<{ discarded: string[]; refused: string[] }>(
    target,
    'git.bulkDiscard',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), filePaths, observed: targets },
    { timeoutMs: 15_000 }
  )
}

/**
 * Discard one path, optionally stating the working-tree content the caller observed.
 *
 * The precondition is checked by whichever host owns the worktree, never here: the caller is the party
 * that cannot know whether the file still holds what it saw. Each transport answers version skew
 * differently, and the differences are the point rather than an inconsistency --
 *
 *   local IPC: preload and main ship in one bundle, so no skew exists and the extra field is safe.
 *   SSH relay: the provider sends a differently-named request, which an older relay cannot handle, so
 *              it errors instead of destroying. Fail-closed by construction, no negotiation table.
 *   remote runtime: an older runtime would parse the field and ignore it, which is fail-OPEN and the
 *              worst case -- the caller believes it is protected and the file is gone. So the
 *              capability is asserted BEFORE the request, because a response cannot un-destroy a file.
 */
export async function discardRuntimeGitPath(
  context: RuntimeGitContext,
  filePath: string,
  precondition: DiscardPrecondition | undefined
): Promise<void> {
  const expectedContent = precondition?.expectedContent
  // Why a refusal rather than the old unprotected call: a row without an identity is not a row whose
  // content is unchanged, and the rows that lack one are reachable -- a status listing past its entry
  // cap is stamped with nothing, and the huge-repository state is a banner rather than a replacement
  // for the list, so those rows still render a working discard button. Letting them through would fence
  // the ordinary path and leave the degraded one open, which is a gate built beside a hole. Here rather
  // than in the hook that calls it today, so the next caller inherits it without remembering to.
  if (typeof expectedContent !== 'string' || expectedContent.length === 0) {
    throw new DiscardObservedStateRequiredError(filePath)
  }
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.discard({
      worktreePath: resolveLocalWorktreePath(context),
      filePath,
      connectionId: context.connectionId,
      expectedContent
    })
    return
  }
  await assertRuntimeEnvironmentCapability(
    target.environmentId,
    GIT_DISCARD_STALE_STATE_RUNTIME_CAPABILITY,
    DISCARD_HOST_CANNOT_CHECK_MESSAGE
  )
  await callRuntimeRpc(
    target,
    'git.discard',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      filePath,
      expectedContent
    },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitRemoteFileUrl(
  context: RuntimeGitContext,
  args: { relativePath: string; line: number }
): Promise<string | null> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.remoteFileUrl({
      worktreePath: resolveLocalWorktreePath(context),
      relativePath: args.relativePath,
      line: args.line,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<string | null>(
    target,
    'git.remoteFileUrl',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      relativePath: args.relativePath,
      line: args.line
    },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitRemoteCommitUrl(
  context: RuntimeGitContext,
  args: { sha: string }
): Promise<string | null> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.remoteCommitUrl({
      worktreePath: resolveLocalWorktreePath(context),
      sha: args.sha,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<string | null>(
    target,
    'git.remoteCommitUrl',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      sha: args.sha
    },
    { timeoutMs: 15_000 }
  )
}
