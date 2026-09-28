// The single authority over one question: may Orca materialize a provider's "this folder is
// trusted" artifact for this workspace?
//
// Why this exists: that artifact is the provider's own safety control against executing untrusted
// repository content. Orca used to pre-write it so the provider's first-launch menu could not
// swallow a bracketed paste — a real problem, solved by answering a security prompt on the user's
// behalf, permanently, in their real home. "Orca launched an agent here" is not "the user trusts
// this folder", and only the second one authorizes the write.
//
// Why the producers consult this rather than their callers: the effect has five production call
// sites across desktop launch prep, desktop resume, a renderer-callable IPC channel, remote
// worktrees and the runtime/headless host. Guarding the callers would fence the ones that exist
// today and leave every future one open. The three local producers and the one remote producer are
// the narrowest choke point every caller crosses, including callers not written yet.
//
// Refusal is not failure. A refused grant means the provider shows its own trust prompt — the
// control being restored, not lost.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AgentTrustPreset } from './agent-trust-presets'
import { getOrcaUserDataPath } from './codex/codex-home-paths'
import { canonicalizeWorkspacePath } from './workspace-path-identity'

const CONSENT_FILE = 'workspace-execution-consent.json'

/**
 * Where the grant applies. A remote workspace path means nothing without the host it lives on:
 * `/home/me/project` on one machine must never authorize the same path on another.
 */
export type WorkspaceExecutionScope = { kind: 'local' } | { kind: 'ssh'; connectionId: string }

export const LOCAL_WORKSPACE_SCOPE: WorkspaceExecutionScope = { kind: 'local' }

/**
 * Three refusals, never one. "The user said no", "nobody ever asked" and "the record exists but
 * could not be read" need different fixes and different words, and collapsing them tells the user
 * something false about their own decision.
 */
export type WorkspaceExecutionConsentOutcome =
  | { decision: 'granted' }
  | { decision: 'refused'; reason: 'denied' | 'unrecorded' | 'unreadable'; detail?: string }

export type WorkspaceTrustWriteOutcome =
  | { written: true }
  | { written: false; refusedBecause: 'denied' | 'unrecorded' | 'unreadable' }

type ConsentGrant = { decision: 'granted' | 'denied'; at: string }
type ConsentStore = { version: number; grants: Record<string, ConsentGrant> }

export const CONSENT_STORE_VERSION = 1

function storePath(): string {
  return join(getOrcaUserDataPath(), CONSENT_FILE)
}

function scopeKey(scope: WorkspaceExecutionScope): string {
  return scope.kind === 'local' ? 'local' : `ssh:${scope.connectionId}`
}

/**
 * The key is computed here and nowhere else, after canonicalization, so a grant recorded through
 * one spelling of a path is found through any other spelling of the same path.
 *
 * A remote path is NOT canonicalized locally: realpath would resolve against this machine, which is
 * the wrong filesystem. The caller has already asked the remote host.
 */
export function workspaceConsentKey(args: {
  scope: WorkspaceExecutionScope
  workspacePath: string
  preset: AgentTrustPreset
}): string {
  const path =
    args.scope.kind === 'local'
      ? canonicalizeWorkspacePath(args.workspacePath)
      : args.workspacePath
  return `${scopeKey(args.scope)}\u0000${path}\u0000${args.preset}`
}

type StoreReadResult =
  | { outcome: 'read'; store: ConsentStore }
  | { outcome: 'absent' }
  | { outcome: 'unreadable'; detail: string }

function readStore(): StoreReadResult {
  let raw: string
  try {
    raw = readFileSync(storePath(), 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { outcome: 'absent' }
    }
    return { outcome: 'unreadable', detail: (error as Error)?.message ?? 'read failed' }
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { outcome: 'unreadable', detail: 'consent store is not an object' }
    }
    const grants = (parsed as ConsentStore).grants
    if (!grants || typeof grants !== 'object' || Array.isArray(grants)) {
      return { outcome: 'unreadable', detail: 'consent store has no grants map' }
    }
    return { outcome: 'read', store: { version: CONSENT_STORE_VERSION, grants } }
  } catch (error) {
    // A corrupt store is NOT an empty store. Reporting it as "nobody asked" would invite a consent
    // prompt whose answer lands beside a file that cannot be read, and would hide a real fault.
    return { outcome: 'unreadable', detail: (error as Error)?.message ?? 'parse failed' }
  }
}

/**
 * Fail-closed on every path that is not an explicit recorded grant. An absent record is not
 * permission; it is the absence of a question ever having been asked.
 */
export function resolveWorkspaceExecutionConsent(args: {
  scope: WorkspaceExecutionScope
  workspacePath: string
  preset: AgentTrustPreset
}): WorkspaceExecutionConsentOutcome {
  const read = readStore()
  if (read.outcome === 'absent') {
    return { decision: 'refused', reason: 'unrecorded' }
  }
  if (read.outcome === 'unreadable') {
    return { decision: 'refused', reason: 'unreadable', detail: read.detail }
  }
  const grant = read.store.grants[workspaceConsentKey(args)]
  if (!grant) {
    return { decision: 'refused', reason: 'unrecorded' }
  }
  if (grant.decision === 'denied') {
    return { decision: 'refused', reason: 'denied' }
  }
  if (grant.decision !== 'granted') {
    // An unrecognized decision string is not a grant. Anything this reader cannot positively
    // identify as consent is refused.
    return { decision: 'refused', reason: 'unreadable', detail: 'unrecognized decision' }
  }
  return { decision: 'granted' }
}

/** Convenience for the producers: the whole gate as one call. */
export function refusalFor(args: {
  scope: WorkspaceExecutionScope
  workspacePath: string
  preset: AgentTrustPreset
}): WorkspaceTrustWriteOutcome | null {
  const consent = resolveWorkspaceExecutionConsent(args)
  return consent.decision === 'granted' ? null : { written: false, refusedBecause: consent.reason }
}
