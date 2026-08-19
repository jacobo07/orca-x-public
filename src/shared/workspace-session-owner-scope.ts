import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from './workspace-session-state-types'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from './workspace-session-field-ownership'
import {
  buildWorktreeIdByFileId,
  buildWorktreeIdByTabId,
  isWorkspaceSessionRecord,
  type WorkspaceSessionRecord
} from './workspace-session-records'

/**
 * Merge a session publication that speaks for only part of the workspace.
 *
 * The default publication path replaces a field wholesale, so a writer that
 * knows one project publishes a record missing every other project and erases
 * it. A writer that declares its scope keeps that blast radius inside the
 * worktrees it owns: entries it does not own survive untouched, and entries it
 * does own are replaced by what it published — including removal, which is how
 * closing a tab still persists.
 *
 * Scoping reuses WORKSPACE_SESSION_FIELD_OWNERSHIP rather than a second list,
 * so a newly added field is scoped the moment it is classified for the host
 * split, and the compile-time exhaustiveness guard covers both axes.
 */

export type OwnsWorktree = (worktreeId: string) => boolean

/** Declares the worktrees a session write speaks for. Absent means the writer
 *  speaks for the whole workspace, which is the single-window default. */
export type WorkspaceSessionWriteScope = {
  ownedWorktreeIds?: readonly string[]
}

/** Resolve the worktree an entry belongs to, or null when it cannot be attributed. */
type ResolveEntryWorktreeId = (key: string, entry: unknown) => string | null

function resolveRecordWorktreeId(entry: unknown): string | null {
  return isWorkspaceSessionRecord(entry) && typeof entry.worktreeId === 'string'
    ? entry.worktreeId
    : null
}

function resolveFirstPageWorktreeId(entry: unknown): string | null {
  const first = Array.isArray(entry) ? (entry[0] as { worktreeId?: string } | undefined) : undefined
  return typeof first?.worktreeId === 'string' ? first.worktreeId : null
}

function buildEntryWorktreeResolver(
  ownership: (typeof WORKSPACE_SESSION_FIELD_OWNERSHIP)[keyof typeof WORKSPACE_SESSION_FIELD_OWNERSHIP],
  current: WorkspaceSessionState
): ResolveEntryWorktreeId | null {
  switch (ownership) {
    case 'worktreeKeyed':
      return (key) => key
    case 'tabKeyed': {
      const byTabId = buildWorktreeIdByTabId(current)
      return (key) => byTabId.get(key) ?? null
    }
    case 'fileKeyed': {
      const byFileId = buildWorktreeIdByFileId(current)
      return (key) => byFileId.get(key) ?? null
    }
    case 'paneKeyed': {
      const byTabId = buildWorktreeIdByTabId(current)
      return (key) => {
        const separator = key.lastIndexOf(':')
        return separator > 0 ? (byTabId.get(key.slice(0, separator)) ?? null) : null
      }
    }
    case 'browserWorkspaceKeyed':
      return (_key, entry) => resolveFirstPageWorktreeId(entry)
    case 'sleepingAgentKeyed':
    case 'surfaceTombstoneKeyed':
      return (_key, entry) => resolveRecordWorktreeId(entry)
    default:
      return null
  }
}

function mergeScopedRecordField(
  currentValue: unknown,
  patchValue: unknown,
  ownsWorktree: OwnsWorktree,
  resolveEntryWorktreeId: ResolveEntryWorktreeId
): unknown {
  if (!isWorkspaceSessionRecord(patchValue)) {
    return patchValue
  }
  const retained: WorkspaceSessionRecord = {}
  if (isWorkspaceSessionRecord(currentValue)) {
    for (const [key, entry] of Object.entries(currentValue)) {
      const worktreeId = resolveEntryWorktreeId(key, entry)
      // Why: an entry nobody can attribute is never deleted on someone else's
      // behalf — an unowned-looking orphan is far cheaper than a lost session.
      if (worktreeId === null || !ownsWorktree(worktreeId)) {
        retained[key] = entry
      }
    }
  }
  return { ...retained, ...patchValue }
}

function mergeScopedWorktreeArrayField(
  currentValue: unknown,
  patchValue: unknown,
  ownsWorktree: OwnsWorktree
): unknown {
  if (!Array.isArray(patchValue)) {
    return patchValue
  }
  const retained = Array.isArray(currentValue)
    ? (currentValue as string[]).filter((worktreeId) => !ownsWorktree(worktreeId))
    : []
  return [...new Set([...retained, ...(patchValue as string[])])]
}

/**
 * Apply `patch` to `current` on behalf of a writer that owns only the worktrees
 * `ownsWorktree` accepts. Global and host-private fields keep replace semantics
 * — they are not worktree-scoped, so there is no other owner to protect.
 */
export function mergeOwnerScopedSessionPatch(
  current: WorkspaceSessionState,
  patch: WorkspaceSessionPatch,
  ownsWorktree: OwnsWorktree
): WorkspaceSessionState {
  const next: WorkspaceSessionState = { ...current }
  for (const [field, patchValue] of Object.entries(patch) as [
    keyof WorkspaceSessionState,
    unknown
  ][]) {
    const ownership = WORKSPACE_SESSION_FIELD_OWNERSHIP[field]
    if (ownership === undefined) {
      ;(next as WorkspaceSessionRecord)[field] = patchValue
      continue
    }
    if (ownership === 'worktreeArray') {
      ;(next as WorkspaceSessionRecord)[field] = mergeScopedWorktreeArrayField(
        current[field],
        patchValue,
        ownsWorktree
      )
      continue
    }
    const resolveEntryWorktreeId = buildEntryWorktreeResolver(ownership, current)
    if (resolveEntryWorktreeId === null) {
      ;(next as WorkspaceSessionRecord)[field] = patchValue
      continue
    }
    ;(next as WorkspaceSessionRecord)[field] = mergeScopedRecordField(
      current[field],
      patchValue,
      ownsWorktree,
      resolveEntryWorktreeId
    )
  }
  return next
}

/** Build an owner predicate from an explicit list of owned worktree ids. */
export function ownsOneOfWorktrees(ownedWorktreeIds: readonly string[]): OwnsWorktree {
  const owned = new Set(ownedWorktreeIds)
  return (worktreeId) => owned.has(worktreeId)
}
