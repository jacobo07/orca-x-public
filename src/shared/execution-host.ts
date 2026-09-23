import type { GlobalSettings } from './global-settings-types'
import type { Repo } from './repo-types'
import type { Worktree } from './worktree/types'

export const LOCAL_EXECUTION_HOST_ID = 'local'
export const ALL_EXECUTION_HOSTS_SCOPE = 'all'

export type ExecutionHostKind = 'local' | 'ssh' | 'runtime'
export type ExecutionHostId = typeof LOCAL_EXECUTION_HOST_ID | `ssh:${string}` | `runtime:${string}`

export type ExecutionHostScope = typeof ALL_EXECUTION_HOSTS_SCOPE | ExecutionHostId

export type ParsedExecutionHost =
  | { kind: 'local'; id: typeof LOCAL_EXECUTION_HOST_ID }
  | { kind: 'ssh'; id: `ssh:${string}`; targetId: string }
  | { kind: 'runtime'; id: `runtime:${string}`; environmentId: string }

function getCurrentLocalPlatform(): NodeJS.Platform | null {
  const globalNavigator = (globalThis as { navigator?: { userAgent?: string; platform?: string } })
    .navigator
  const userAgent = globalNavigator?.userAgent || globalNavigator?.platform || ''
  if (/Windows/i.test(userAgent)) {
    return 'win32'
  }
  if (/Mac/i.test(userAgent)) {
    return 'darwin'
  }
  if (/Linux|X11/i.test(userAgent)) {
    return 'linux'
  }
  return typeof process === 'undefined' ? null : process.platform
}

export function getLocalExecutionHostLabel(platform: NodeJS.Platform | null = null): string {
  const localPlatform = platform ?? getCurrentLocalPlatform()
  if (localPlatform === 'darwin') {
    return 'Local Mac'
  }
  if (localPlatform === 'win32') {
    return 'Local Windows'
  }
  if (localPlatform === 'linux') {
    return 'Local Linux'
  }
  return 'This computer'
}

function normalizeHostPart(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function toSshExecutionHostId(targetId: string): `ssh:${string}` {
  return `ssh:${encodeURIComponent(targetId)}`
}

export function toRuntimeExecutionHostId(environmentId: string): `runtime:${string}` {
  return `runtime:${encodeURIComponent(environmentId)}`
}

// Why: runtime-owned (ephemeral-VM) SSH targets are hidden from user-facing
// SSH/run-target surfaces. The renderer can't read the target.owner field, so it
// recognizes them by their deterministic id prefix. getRuntimeOwnedSshTargetId
// (main) builds on this same prefix to keep the two in sync.
export const RUNTIME_OWNED_SSH_TARGET_ID_PREFIX = 'runtime-ssh-'

export function isRuntimeOwnedSshTargetId(targetId: string | null | undefined): boolean {
  return typeof targetId === 'string' && targetId.startsWith(RUNTIME_OWNED_SSH_TARGET_ID_PREFIX)
}

export function parseExecutionHostId(value: string | null | undefined): ParsedExecutionHost | null {
  const normalized = normalizeHostPart(value)
  if (!normalized) {
    return null
  }
  if (normalized === LOCAL_EXECUTION_HOST_ID) {
    return { kind: 'local', id: LOCAL_EXECUTION_HOST_ID }
  }
  if (normalized.startsWith('ssh:')) {
    const encoded = normalized.slice('ssh:'.length)
    if (!encoded) {
      return null
    }
    try {
      const targetId = decodeURIComponent(encoded)
      return targetId ? { kind: 'ssh', id: `ssh:${encoded}`, targetId } : null
    } catch {
      return null
    }
  }
  if (normalized.startsWith('runtime:')) {
    const encoded = normalized.slice('runtime:'.length)
    if (!encoded) {
      return null
    }
    try {
      const environmentId = decodeURIComponent(encoded)
      return environmentId ? { kind: 'runtime', id: `runtime:${encoded}`, environmentId } : null
    } catch {
      return null
    }
  }
  return null
}

export function normalizeExecutionHostId(value: string | null | undefined): ExecutionHostId | null {
  return parseExecutionHostId(value)?.id ?? null
}

// Why: an absent scope and an unresolvable one are different answers, and collapsing
// them is what let a stale or malformed host id widen a single-host request into a
// fan-out. Absence lets each caller apply its own default; a value that is not a host
// is corrupt input, and the one scope it must never become is all-hosts.
export type ExecutionHostScopeResolution =
  | { kind: 'scope'; scope: ExecutionHostScope }
  | { kind: 'absent' }
  | { kind: 'unresolvable'; value: string }

export function resolveExecutionHostScope(
  value: string | null | undefined
): ExecutionHostScopeResolution {
  const normalized = normalizeHostPart(value)
  if (!normalized) {
    return { kind: 'absent' }
  }
  if (normalized === ALL_EXECUTION_HOSTS_SCOPE) {
    return { kind: 'scope', scope: ALL_EXECUTION_HOSTS_SCOPE }
  }
  const id = normalizeExecutionHostId(normalized)
  return id ? { kind: 'scope', scope: id } : { kind: 'unresolvable', value: normalized }
}

// An omitted scope on a listing surface means "no host filter", which is every host.
// null is the refusal: the value was present and is not a host.
export function normalizeExecutionHostScope(
  value: string | null | undefined
): ExecutionHostScope | null {
  const resolved = resolveExecutionHostScope(value)
  if (resolved.kind === 'absent') {
    return ALL_EXECUTION_HOSTS_SCOPE
  }
  return resolved.kind === 'scope' ? resolved.scope : null
}

// An omitted scope on a request means this host, not a fan-out. Callers and the
// renderer share this so both agree on which requests answer with a merge.
export function requestedExecutionHostScope(
  value: string | null | undefined
): ExecutionHostScope | null {
  const resolved = resolveExecutionHostScope(value)
  if (resolved.kind === 'absent') {
    return LOCAL_EXECUTION_HOST_ID
  }
  return resolved.kind === 'scope' ? resolved.scope : null
}

export function normalizeVisibleExecutionHostIds(
  value: readonly string[] | null | undefined
): ExecutionHostId[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const ids: ExecutionHostId[] = []
  const seen = new Set<ExecutionHostId>()
  for (const raw of value) {
    const id = normalizeExecutionHostId(raw)
    if (!id || seen.has(id)) {
      continue
    }
    seen.add(id)
    ids.push(id)
  }
  return ids.length > 0 ? ids : null
}

// Why: for a visible-host list, null means "no filter", which is every host. A list
// the user narrowed to and that can no longer be read must not collapse into the same
// answer as no list at all — that is the scope widening one container out. Dropping
// unreadable members from a list that still has survivors is a narrowing and stays.
export type VisibleExecutionHostIdsResolution =
  | { kind: 'ids'; ids: ExecutionHostId[] }
  | { kind: 'absent' }
  | { kind: 'unresolvable' }

export function resolveVisibleExecutionHostIds(
  value: readonly string[] | null | undefined
): VisibleExecutionHostIdsResolution {
  if (!Array.isArray(value)) {
    return { kind: 'absent' }
  }
  const ids = normalizeVisibleExecutionHostIds(value)
  if (ids) {
    return { kind: 'ids', ids }
  }
  return value.length > 0 ? { kind: 'unresolvable' } : { kind: 'absent' }
}

export function normalizeExecutionHostOrder(
  value: readonly string[] | null | undefined
): ExecutionHostId[] {
  const normalized = normalizeVisibleExecutionHostIds(value)
  return normalized ?? []
}

export function getRepoExecutionHostId(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): ExecutionHostId {
  const executionHostId = normalizeExecutionHostId(repo.executionHostId)
  if (executionHostId) {
    return executionHostId
  }
  const connectionId = normalizeHostPart(repo.connectionId)
  return connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID
}

export function getWorktreeExecutionHostId(
  worktree: Pick<Worktree, 'hostId'>,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined,
  defaultHostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
): ExecutionHostId {
  // Why: runtime and SSH snapshots can identify a more precise owner than
  // the repo fallback; every sidebar host decision must use the same precedence.
  return (
    worktree.hostId ??
    (repo?.connectionId || repo?.executionHostId ? getRepoExecutionHostId(repo) : defaultHostId)
  )
}

export function getSettingsFocusedExecutionHostId(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): ExecutionHostId {
  const runtimeEnvironmentId = normalizeHostPart(settings?.activeRuntimeEnvironmentId)
  return runtimeEnvironmentId
    ? toRuntimeExecutionHostId(runtimeEnvironmentId)
    : LOCAL_EXECUTION_HOST_ID
}

export function getExecutionHostLabel(id: ExecutionHostScope): string {
  if (id === ALL_EXECUTION_HOSTS_SCOPE) {
    return 'All hosts'
  }
  const parsed = parseExecutionHostId(id)
  if (!parsed) {
    return 'All hosts'
  }
  switch (parsed.kind) {
    case 'local':
      return getLocalExecutionHostLabel()
    case 'ssh':
      return parsed.targetId
    case 'runtime':
      return parsed.environmentId
  }
}
