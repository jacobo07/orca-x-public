import type {
  PersistedTrustedOrcaHookEntry,
  PersistedTrustedOrcaHooks
} from '../../../../shared/orca-yaml-hook-types'

type PrepareApprovalSlice = { trustedOrcaHooks: PersistedTrustedOrcaHooks }

const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/

function withApproval(
  hooks: PersistedTrustedOrcaHooks,
  repoId: string,
  requirementId: string,
  entry: PersistedTrustedOrcaHookEntry
): PersistedTrustedOrcaHooks {
  const existing = Object.hasOwn(hooks, repoId) ? hooks[repoId] : undefined
  return {
    ...hooks,
    [repoId]: { ...existing, prepare: { ...existing?.prepare, [requirementId]: entry } }
  }
}

/**
 * Records the approval and resolves only after main acknowledged the write; rejects with the store
 * untouched when it did not. In main this is an in-memory update plus a debounced save, last writer
 * wins across windows: acknowledged, not crash-durable.
 */
export async function approvePrepareStepInStore(
  get: () => PrepareApprovalSlice,
  set: (partial: Partial<PrepareApprovalSlice>) => void,
  repoId: string,
  requirementId: string,
  contentHash: string
): Promise<void> {
  const entry = { contentHash, approvedAt: Date.now() }
  const base = get().trustedOrcaHooks
  await window.api.ui.set({
    trustedOrcaHooks: withApproval(base, repoId, requirementId, entry)
  })
  // Why: another trust write may have landed while this one was in flight; merge into the current
  // value and, if it moved, write again so main also ends up holding both.
  const latest = get().trustedOrcaHooks
  const merged = withApproval(latest, repoId, requirementId, entry)
  if (latest !== base) {
    await window.api.ui.set({ trustedOrcaHooks: merged })
  }
  set({ trustedOrcaHooks: withApproval(get().trustedOrcaHooks, repoId, requirementId, entry) })
}

function isWellFormed(entry: unknown): entry is PersistedTrustedOrcaHookEntry {
  if (typeof entry !== 'object' || entry === null) {
    return false
  }
  const { contentHash, approvedAt } = entry as Record<string, unknown>
  return (
    typeof contentHash === 'string' &&
    CONTENT_HASH_PATTERN.test(contentHash) &&
    typeof approvedAt === 'number' &&
    Number.isFinite(approvedAt)
  )
}

/** requirement id -> approved hash, for well-formed entries only; repo-wide `all` is never read. */
export function readPrepareApprovals(
  hooks: PersistedTrustedOrcaHooks,
  repoId: string
): Record<string, string> {
  const approvals: Record<string, string> = {}
  if (!Object.hasOwn(hooks, repoId)) {
    return approvals
  }
  const prepare = hooks[repoId]?.prepare
  if (typeof prepare !== 'object' || prepare === null) {
    return approvals
  }
  for (const [requirementId, entry] of Object.entries(prepare)) {
    if (isWellFormed(entry)) {
      approvals[requirementId] = entry.contentHash
    }
  }
  return approvals
}
