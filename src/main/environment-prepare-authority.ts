import { prepareApprovalHash, type Sha256Hex } from '../shared/environment-prepare-plan'
import type { RequirementState } from '../shared/environment-requirement-state'
import type {
  EnvironmentRequirement,
  EvaluatedRequirement
} from '../shared/environment-requirement-types'
import { isEvaluatedRequirement } from '../shared/environment-requirement-types'

export type PrepareRefusalReason =
  | 'contract-unreadable'
  | 'requirement-not-declared'
  | 'approval-for-another-host'
  | 'contract-changed'
  | 'approval-unreadable'
  | 'approval-missing'
  | 'host-identity-unverified'
  | 'already-satisfied'
  | 'requirement-not-applicable'

// What the host re-read from orca.yaml, already parsed. Unreadable and unparseable are different
// from "declares nothing": they refuse by their own name.
export type PrepareContract =
  | { status: 'parsed'; requirements: EnvironmentRequirement[] }
  | { status: 'absent' }
  | { status: 'unreadable' }
  | { status: 'unparseable' }

// Three-way on purpose: a store that cannot be read is not a store that holds nothing.
export type PersistedApprovalRead =
  | { status: 'present'; entry: unknown }
  | { status: 'absent' }
  | { status: 'unreadable' }

export type AuthorizePrepareInput = {
  requirementId: string
  contract: PrepareContract
  // The executing host's own key, never the caller's.
  hostKey: string
  approvedContentHash: string
  // Provenance only: it picks the refusal reason, it never widens what the hash allows.
  approvedHostKey: string
  persistedApproval: PersistedApprovalRead
  requirePersistedApproval: boolean
  hostIdentity: string
  remeasuredState: RequirementState
}

export type AuthorizePrepareResult =
  | { authorized: true; bytes: string }
  | { authorized: false; reason: PrepareRefusalReason }

const TRUSTED_HOST_IDENTITIES = new Set(['local', 'pinned', 'delegated-to-openssh'])
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/

function isWellFormedEntry(entry: unknown): entry is { contentHash: string; approvedAt: number } {
  if (typeof entry !== 'object' || entry === null) {
    return false
  }
  const { contentHash, approvedAt } = entry as { contentHash?: unknown; approvedAt?: unknown }
  return (
    typeof contentHash === 'string' &&
    CONTENT_HASH_PATTERN.test(contentHash) &&
    typeof approvedAt === 'number' &&
    Number.isFinite(approvedAt)
  )
}

export type DeclaredPrepare =
  | { ok: true; requirement: EvaluatedRequirement; bytes: string }
  | { ok: false; reason: 'contract-unreadable' | 'requirement-not-declared' }

// The requirement must carry a prepare in the contract as this host read it just now.
export function findDeclaredPrepare(
  contract: PrepareContract,
  requirementId: string
): DeclaredPrepare {
  if (contract.status === 'unreadable' || contract.status === 'unparseable') {
    return { ok: false, reason: 'contract-unreadable' }
  }
  if (contract.status === 'absent') {
    return { ok: false, reason: 'requirement-not-declared' }
  }
  const requirement = contract.requirements.find((entry) => entry.id === requirementId)
  if (
    !requirement ||
    !isEvaluatedRequirement(requirement) ||
    typeof requirement.prepare !== 'string'
  ) {
    return { ok: false, reason: 'requirement-not-declared' }
  }
  return { ok: true, requirement, bytes: requirement.prepare }
}

// Why: repo-wide `all` trust never covers a prepare step, so only the per-requirement map is read,
// and only own keys (an id such as `constructor` must not find an inherited value).
export function readPersistedPrepareApproval(
  getTrustedOrcaHooks: () => unknown,
  repoId: string,
  requirementId: string
): PersistedApprovalRead {
  try {
    const hooks = getTrustedOrcaHooks()
    if (hooks === undefined || hooks === null) {
      return { status: 'absent' }
    }
    if (typeof hooks !== 'object') {
      return { status: 'unreadable' }
    }
    if (!Object.hasOwn(hooks, repoId)) {
      return { status: 'absent' }
    }
    const repoRecord = (hooks as Record<string, unknown>)[repoId]
    if (typeof repoRecord !== 'object' || repoRecord === null) {
      return { status: 'unreadable' }
    }
    const prepare = (repoRecord as { prepare?: unknown }).prepare
    if (typeof prepare !== 'object' || prepare === null || !Object.hasOwn(prepare, requirementId)) {
      return { status: 'absent' }
    }
    return { status: 'present', entry: (prepare as Record<string, unknown>)[requirementId] }
  } catch {
    return { status: 'unreadable' }
  }
}

// Decided on the executing host, over the bytes it re-read; the first failing condition names the refusal.
export async function authorizePrepareStep(
  input: AuthorizePrepareInput,
  deps: { sha256Hex: Sha256Hex }
): Promise<AuthorizePrepareResult> {
  const declared = findDeclaredPrepare(input.contract, input.requirementId)
  if (!declared.ok) {
    return { authorized: false, reason: declared.reason }
  }
  const expected = await prepareApprovalHash(
    input.requirementId,
    input.hostKey,
    declared.bytes,
    deps.sha256Hex
  )
  if (expected !== input.approvedContentHash) {
    return {
      authorized: false,
      reason:
        input.approvedHostKey !== input.hostKey ? 'approval-for-another-host' : 'contract-changed'
    }
  }
  if (input.requirePersistedApproval) {
    if (input.persistedApproval.status === 'unreadable') {
      return { authorized: false, reason: 'approval-unreadable' }
    }
    const stored =
      input.persistedApproval.status === 'present' ? input.persistedApproval.entry : undefined
    if (!isWellFormedEntry(stored) || stored.contentHash !== expected) {
      return { authorized: false, reason: 'approval-missing' }
    }
  }
  if (!TRUSTED_HOST_IDENTITIES.has(input.hostIdentity)) {
    return { authorized: false, reason: 'host-identity-unverified' }
  }
  if (input.remeasuredState === 'satisfied') {
    return { authorized: false, reason: 'already-satisfied' }
  }
  if (input.remeasuredState === 'unsupported') {
    return { authorized: false, reason: 'requirement-not-applicable' }
  }
  return { authorized: true, bytes: declared.bytes }
}
