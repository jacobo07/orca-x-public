// Comparison service (row 63): capability-probe the relay, list its tips, export a bundle, pull it in
// sha256-checked chunks, verify-then-fetch it, and decide ancestry on the transferred objects.
// The relay request function is injected (the SSH relay session in production), so every step is awaited here.
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deriveReplicaRelation,
  type ReplicaFacts,
  type ReplicaPairEvidence,
  type ReplicaRelation,
  type ReplicaUnknownReason
} from '../shared/workspace-replica-state'
import { gitExecFileAsync } from './git/runner'
import { decideReplicaAncestry, receiveReplicaBundle, type DeclaredHead } from './replica-bundle-receive'
import { isDiskFullError, type ReplicaFailureCause } from './replica-failure-cause'
import { getSshConnectionGeneration } from './ssh/ssh-connection-generation'
import { relaySupportsReplicaBundle, type RelayCapabilityRequest } from './ssh/ssh-relay-capabilities'

export type ReplicaComparisonRequest = RelayCapabilityRequest

const CALL_TIMEOUT_MS = 120_000
const CHUNK_BYTES = 256 * 1024
const SHA = /^[0-9a-f]{40,64}$/

export type ReplicaComparisonFailure =
  | 'relay-unsupported'
  | 'relay-bad-response'
  | 'transfer-interrupted'
  | 'bundle-verify-failed'
  | 'bundle-heads-mismatch'
  | 'no-comparable-tip'

export type ReplicaComparisonResult =
  | { ok: true; evidence: ReplicaPairEvidence; refs: Record<string, string> }
  | {
      ok: false
      reason: ReplicaComparisonFailure
      evidence: ReplicaPairEvidence | null
      cause?: ReplicaFailureCause
    }

function parseHeads(value: unknown): DeclaredHead[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const heads: DeclaredHead[] = []
  for (const h of value) {
    const { ref, sha } = (h ?? {}) as { ref?: unknown; sha?: unknown }
    if (typeof ref !== 'string' || typeof sha !== 'string' || !SHA.test(sha)) {
      return null
    }
    heads.push({ ref, sha })
  }
  return heads
}

export async function compareWithRelayReplica(args: {
  connectionId: string
  generation: number
  request: ReplicaComparisonRequest
  /** Local repo (A). */
  localRepoPath: string
  /** Repo path on the relay host (B). */
  remoteRepoPath: string
  /** Label for refs/orca/replicas/<hostKey>/*. */
  hostKey: string
  /** Ref compared on both sides; defaults to HEAD. */
  ref?: string
  now?: () => number
}): Promise<ReplicaComparisonResult> {
  const { connectionId, generation, request, localRepoPath, remoteRepoPath, hostKey } = args
  const ref = args.ref ?? 'HEAD'
  const call = (method: string, params: Record<string, unknown>): Promise<unknown> =>
    request(method, params, { timeoutMs: CALL_TIMEOUT_MS })

  // 1. Capability probe: an old relay is never sent replica calls.
  let supported = false
  try {
    supported = await relaySupportsReplicaBundle(connectionId, generation, request)
  } catch {
    return { ok: false, reason: 'relay-unsupported', evidence: null }
  }
  if (!supported) {
    return { ok: false, reason: 'relay-unsupported', evidence: null }
  }

  let exportId: string | null = null
  const dir = await mkdtemp(join(tmpdir(), 'orca-replica-recv-'))
  const bundlePath = join(dir, `${randomUUID()}.bundle`)
  try {
    // 2. Export on the relay, then pull sha256-checked chunks.
    const exported = (await call('git.replicaBundleExport', { repoPath: remoteRepoPath })) as {
      exportId?: unknown
      size?: unknown
      sha256?: unknown
      heads?: unknown
    } | null
    const heads = parseHeads(exported?.heads)
    if (
      !exported ||
      typeof exported.exportId !== 'string' ||
      typeof exported.size !== 'number' ||
      typeof exported.sha256 !== 'string' ||
      !heads
    ) {
      return { ok: false, reason: 'relay-bad-response', evidence: null }
    }
    exportId = exported.exportId
    const remoteTip = heads.find((h) => h.ref === ref)?.sha
    if (!remoteTip) {
      return { ok: false, reason: 'no-comparable-tip', evidence: null }
    }

    const hash = createHash('sha256')
    const fh = await open(bundlePath, 'w')
    let offset = 0
    try {
      for (;;) {
        const chunk = (await call('git.replicaBundleRead', {
          exportId,
          offset,
          length: CHUNK_BYTES
        })) as { data?: unknown; bytesRead?: unknown; eof?: unknown } | null
        if (!chunk || typeof chunk.data !== 'string' || typeof chunk.bytesRead !== 'number') {
          return { ok: false, reason: 'transfer-interrupted', evidence: null }
        }
        const buf = Buffer.from(chunk.data, 'base64')
        if (buf.length !== chunk.bytesRead) {
          return { ok: false, reason: 'transfer-interrupted', evidence: null }
        }
        try {
          await fh.write(buf, 0, buf.length, offset)
        } catch (error) {
          // Only the local write can fill this host's disk; any other write error propagates as before.
          if (isDiskFullError(error)) {
            return { ok: false, reason: 'transfer-interrupted', evidence: null, cause: 'disk-full' }
          }
          throw error
        }
        hash.update(buf)
        offset += buf.length
        if (chunk.eof === true) {
          break
        }
        if (buf.length === 0) {
          return { ok: false, reason: 'transfer-interrupted', evidence: null }
        }
      }
    } finally {
      await fh.close()
    }
    if (offset !== exported.size || hash.digest('hex') !== exported.sha256) {
      return { ok: false, reason: 'transfer-interrupted', evidence: null }
    }

    // 3. Verify-then-fetch (also unlinks the bundle), then decide ancestry on the received objects.
    const received = await receiveReplicaBundle({
      repoPath: localRepoPath,
      bundlePath,
      declaredHeads: heads,
      hostKey
    })
    if (!received.ok) {
      return {
        ok: false,
        reason: received.reason,
        evidence: null,
        ...(received.cause ? { cause: received.cause } : {})
      }
    }
    let localTip: string
    try {
      const { stdout } = await gitExecFileAsync(['rev-parse', '--verify', `${ref}^{commit}`], {
        cwd: localRepoPath
      })
      localTip = stdout.trim()
    } catch {
      return { ok: false, reason: 'no-comparable-tip', evidence: null }
    }
    const ancestry = await decideReplicaAncestry(localRepoPath, localTip, remoteTip)
    const observedTips = [localTip, remoteTip] as const
    const observedAt = (args.now ?? Date.now)()
    if ('unknown' in ancestry) {
      return {
        ok: false,
        reason: ancestry.unknown,
        evidence: {
          observedTips,
          site: 'local',
          outcome: { ok: false, reason: ancestry.unknown },
          observedAt
        }
      }
    }
    return {
      ok: true,
      refs: received.refs,
      evidence: { observedTips, site: 'local', outcome: { ok: true, ancestry }, observedAt }
    }
  } finally {
    // 4. Always release the relay export (best effort) and drop the local scratch dir.
    if (exportId) {
      await call('git.replicaBundleRelease', { exportId }).catch(() => {})
    }
    await rm(dir, { recursive: true, force: true })
  }
}

const FAILURE_REASON: Record<ReplicaComparisonFailure, ReplicaUnknownReason> = {
  'relay-unsupported': 'relay-too-old',
  'relay-bad-response': 'transfer-interrupted',
  'transfer-interrupted': 'transfer-interrupted',
  'bundle-verify-failed': 'bundle-verify-failed',
  'bundle-heads-mismatch': 'bundle-heads-mismatch',
  'no-comparable-tip': 'tip-unknown'
}

/**
 * Row 62: fold a comparison result into the evidence-only state model. A failed comparison is unknown with a
 * closed reason (never healthy, never a guess); the model's fence rejects evidence for tips that have moved.
 */
export function relationFromComparison(
  a: ReplicaFacts,
  b: ReplicaFacts,
  result: ReplicaComparisonResult
): ReplicaRelation {
  if (result.ok) {
    return deriveReplicaRelation(a, b, result.evidence)
  }
  if (result.evidence) {
    return deriveReplicaRelation(a, b, result.evidence)
  }
  const tip = (f: ReplicaFacts): string =>
    f.kind !== 'folder' && (f.tip.kind === 'commit' || f.tip.kind === 'detached') ? f.tip.sha : ''
  return deriveReplicaRelation(a, b, {
    observedTips: [tip(a), tip(b)],
    site: 'local',
    outcome: { ok: false, reason: FAILURE_REASON[result.reason] }
  })
}

type MuxLike = {
  isDisposed(): boolean
  request(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ): Promise<unknown>
}

export type SshRelaySessionDeps = {
  getMultiplexer: (connectionId: string) => Promise<MuxLike | undefined> | MuxLike | undefined
  getGeneration: (connectionId: string) => number
}

export type SshRelaySession = {
  request: ReplicaComparisonRequest
  /** Generation of the connection when the session was opened. */
  generation: number
  /** Live generation, for a fence that must notice a reconnect during an operation. */
  currentGeneration: () => number
}

/** The one way to reach a host's relay: null when there is no live multiplexer for the connection. */
export async function openSshRelaySession(
  connectionId: string,
  deps?: Partial<SshRelaySessionDeps>
): Promise<SshRelaySession | null> {
  // Loaded on demand so this module stays importable without the Electron-bound SSH layer.
  const getMultiplexer =
    deps?.getMultiplexer ??
    (async (id: string) => (await import('./ipc/ssh')).getActiveMultiplexer(id))
  const getGeneration = deps?.getGeneration ?? getSshConnectionGeneration
  const mux = await getMultiplexer(connectionId)
  if (!mux || mux.isDisposed()) {
    return null
  }
  return {
    request: (method, params, options) => mux.request(method, params, options),
    generation: getGeneration(connectionId),
    currentGeneration: () => getGeneration(connectionId)
  }
}

/** Production entry: binds the comparison to the app's live SSH relay session (multiplexer + generation). */
export async function compareWithSshRelayReplica(
  args: Omit<Parameters<typeof compareWithRelayReplica>[0], 'request' | 'generation'> & {
    deps?: Partial<SshRelaySessionDeps>
  }
): Promise<ReplicaComparisonResult> {
  const { deps, ...rest } = args
  const session = await openSshRelaySession(args.connectionId, deps)
  if (!session) {
    return { ok: false, reason: 'relay-unsupported', evidence: null }
  }
  return compareWithRelayReplica({
    ...rest,
    generation: session.generation,
    request: session.request
  })
}
