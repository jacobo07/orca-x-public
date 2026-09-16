import { z } from 'zod'
import {
  getAgentResumeArgv,
  normalizeAgentProviderSession,
  RESUMABLE_TUI_AGENTS
} from './agent-session-resume'
import { parseExecutionHostId, type ExecutionHostId } from './execution-host'
import {
  PROJECT_WORKING_SET_MANIFEST_VERSION,
  type ProjectWorkingSetManifest,
  type ProjectWorkingSetScope,
  type WorkingSetEntry
} from './project-working-set-types'
import { isTerminalLeafId } from './stable-pane-id'
import { isValidTerminalTabId } from './terminal-tab-id'
import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'
import { splitWorktreeIdForFilesystem } from './worktree/id'
import { parseWorkspaceKey } from './workspace-scope'

/**
 * Reads a sealed working-set manifest, all or nothing.
 *
 * The live session schema salvages per entry and tolerates unknown fields, which is right for a
 * hot file this build owns. A sealed manifest is the opposite case: a salvaged manifest is not the
 * one that was sealed, and a field this version does not define means a writer changed the shape
 * without bumping the version — reading past it would ignore whatever that field protected.
 */

const nonEmpty = z.string().min(1)
const tabIdSchema = nonEmpty.refine(isValidTerminalTabId)
const leafIdSchema = nonEmpty.refine(isTerminalLeafId)

const providerSessionSchema = z
  .strictObject({
    key: z.enum(['session_id', 'conversation_id']),
    id: z.string().min(1).max(512),
    transcriptPath: nonEmpty.optional()
  })
  // Why: the canonical normalizer is the trust boundary for resume ids; a value it would rewrite is not the one captured.
  .refine((session) => {
    const normalized = normalizeAgentProviderSession(session)
    return normalized?.id === session.id && normalized.transcriptPath === session.transcriptPath
  })

const resumeEvidenceSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('provider-session'),
      agent: z.enum(RESUMABLE_TUI_AGENTS),
      providerSession: providerSessionSchema,
      ompResumeFilePath: nonEmpty.nullable()
    })
    .refine(
      (evidence) =>
        getAgentResumeArgv(evidence.agent, evidence.providerSession, evidence.ompResumeFilePath) !==
        null,
      'provider session is not resumable for this agent'
    ),
  z.strictObject({
    kind: z.literal('absent'),
    reason: z.enum(['not-an-agent', 'agent-not-resumable', 'no-provider-session-captured'])
  })
])

const entrySchema = z.strictObject({
  tabId: tabIdSchema,
  label: z.string(),
  color: z.string().nullable(),
  isPinned: z.boolean(),
  launch: z.strictObject({
    launchProfileId: nonEmpty.nullable(),
    launchAgent: z.custom<TuiAgent>((value) => isTuiAgent(value)).nullable(),
    shellOverride: nonEmpty.nullable()
  }),
  startupCwd: nonEmpty.nullable(),
  restorePolicy: z.enum(['auto-restore', 'restore-on-open', 'keep-dormant', 'do-not-restore']),
  activeLeafId: leafIdSchema.nullable(),
  panes: z.array(
    z.strictObject({
      leafId: leafIdSchema,
      title: z.string().nullable(),
      scrollbackRef: nonEmpty.nullable(),
      resume: resumeEvidenceSchema
    })
  )
})

const manifestSchema = z.strictObject({
  manifestVersion: z.literal(PROJECT_WORKING_SET_MANIFEST_VERSION),
  workingSetId: z.uuid(),
  label: z.string().nullable(),
  createdAt: z.number().positive(),
  scope: z.strictObject({
    executionHostId: z.custom<ExecutionHostId>(
      (value) => typeof value === 'string' && parseExecutionHostId(value) !== null
    ),
    ownerKey: nonEmpty,
    location: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('repo-worktree'),
        repoId: nonEmpty,
        worktreePath: nonEmpty
      }),
      z.strictObject({
        kind: z.literal('folder-workspace'),
        folderWorkspaceId: nonEmpty,
        folderPath: nonEmpty
      })
    ])
  }),
  railGroups: z.array(z.array(tabIdSchema).min(1)),
  revivalOrder: z.array(tabIdSchema),
  activeTabId: tabIdSchema.nullable(),
  entries: z.array(entrySchema).min(1)
})

export type WorkingSetCorruptReason =
  | 'shape'
  | 'scope'
  | 'duplicate-entry'
  | 'rail-order'
  | 'revival-order'
  | 'active-selection'

export type WorkingSetManifestReadOutcome =
  | { status: 'valid'; manifest: ProjectWorkingSetManifest }
  /** A version this build cannot read, older or newer. Not a corrupt file. */
  | { status: 'unsupported-version'; manifestVersion: number }
  /** `detail` names ids and paths only, never labels or titles. */
  | { status: 'corrupt'; reason: WorkingSetCorruptReason; detail: string }

type Violation = { reason: WorkingSetCorruptReason; detail: string }

function findScopeViolation(scope: ProjectWorkingSetScope): Violation | null {
  const workspaceKey = parseWorkspaceKey(scope.ownerKey)
  if (workspaceKey?.type === 'folder') {
    return scope.location.kind === 'folder-workspace' &&
      scope.location.folderWorkspaceId === workspaceKey.folderWorkspaceId
      ? null
      : { reason: 'scope', detail: 'folder owner key does not match its location' }
  }
  const parsed = splitWorktreeIdForFilesystem(
    workspaceKey?.type === 'worktree' ? workspaceKey.worktreeId : scope.ownerKey
  )
  if (!parsed) {
    return { reason: 'scope', detail: 'owner key is neither a worktree id nor a workspace key' }
  }
  return scope.location.kind === 'repo-worktree' &&
    scope.location.repoId === parsed.repoId &&
    scope.location.worktreePath === parsed.worktreePath
    ? null
    : { reason: 'scope', detail: 'worktree owner key does not match its location' }
}

function findEntryViolation(entries: readonly WorkingSetEntry[]): Violation | null {
  const tabIds = new Set<string>()
  for (const entry of entries) {
    if (tabIds.has(entry.tabId)) {
      return { reason: 'duplicate-entry', detail: entry.tabId }
    }
    tabIds.add(entry.tabId)
    const leafIds = new Set<string>()
    for (const pane of entry.panes) {
      if (leafIds.has(pane.leafId)) {
        return { reason: 'duplicate-entry', detail: `${entry.tabId}:${pane.leafId}` }
      }
      leafIds.add(pane.leafId)
    }
    if (entry.activeLeafId !== null && !leafIds.has(entry.activeLeafId)) {
      return { reason: 'active-selection', detail: `${entry.tabId}:${entry.activeLeafId}` }
    }
  }
  return null
}

function findRailViolation(
  railGroups: readonly (readonly string[])[],
  entryByTabId: ReadonlyMap<string, WorkingSetEntry>
): Violation | null {
  const placed = new Set<string>()
  for (const tabId of railGroups.flat()) {
    const entry = entryByTabId.get(tabId)
    if (!entry || entry.restorePolicy === 'do-not-restore' || placed.has(tabId)) {
      return { reason: 'rail-order', detail: tabId }
    }
    placed.add(tabId)
  }
  for (const entry of entryByTabId.values()) {
    if (entry.restorePolicy !== 'do-not-restore' && !placed.has(entry.tabId)) {
      return { reason: 'rail-order', detail: `${entry.tabId} is missing from the rail` }
    }
  }
  return null
}

function findRevivalViolation(
  revivalOrder: readonly string[],
  entryByTabId: ReadonlyMap<string, WorkingSetEntry>
): Violation | null {
  const listed = new Set<string>()
  for (const tabId of revivalOrder) {
    if (entryByTabId.get(tabId)?.restorePolicy !== 'auto-restore' || listed.has(tabId)) {
      return { reason: 'revival-order', detail: tabId }
    }
    listed.add(tabId)
  }
  for (const entry of entryByTabId.values()) {
    if (entry.restorePolicy === 'auto-restore' && !listed.has(entry.tabId)) {
      return { reason: 'revival-order', detail: `${entry.tabId} is missing from revival order` }
    }
  }
  return null
}

function findActiveViolation(
  activeTabId: string | null,
  entryByTabId: ReadonlyMap<string, WorkingSetEntry>
): Violation | null {
  if (activeTabId === null) {
    return null
  }
  const entry = entryByTabId.get(activeTabId)
  return entry && entry.restorePolicy !== 'do-not-restore'
    ? null
    : { reason: 'active-selection', detail: activeTabId }
}

export function readProjectWorkingSetManifest(raw: unknown): WorkingSetManifestReadOutcome {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { status: 'corrupt', reason: 'shape', detail: 'not an object' }
  }
  const version = (raw as Record<string, unknown>).manifestVersion
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { status: 'corrupt', reason: 'shape', detail: 'manifestVersion is not an integer' }
  }
  if (version !== PROJECT_WORKING_SET_MANIFEST_VERSION) {
    return { status: 'unsupported-version', manifestVersion: version }
  }
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { status: 'corrupt', reason: 'shape', detail: `${issue.path.join('.')}: ${issue.code}` }
  }
  const manifest: ProjectWorkingSetManifest = parsed.data
  const entryByTabId = new Map(manifest.entries.map((entry) => [entry.tabId, entry]))
  const violation =
    findScopeViolation(manifest.scope) ??
    findEntryViolation(manifest.entries) ??
    findRailViolation(manifest.railGroups, entryByTabId) ??
    findRevivalViolation(manifest.revivalOrder, entryByTabId) ??
    findActiveViolation(manifest.activeTabId, entryByTabId)
  return violation ? { status: 'corrupt', ...violation } : { status: 'valid', manifest }
}
