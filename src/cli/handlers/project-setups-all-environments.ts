import type { ProjectIdentityCollision } from '../../shared/project-identity-collisions'
import type { ProjectHostSetupWithReplicaTopology } from '../../shared/replica-topology'
import { getOptionalStringFlag } from '../flags'
import { formatFanOutListing } from '../replica-topology-format'
import { getDefaultUserDataPath, RuntimeClient } from '../runtime-client'
import { listEnvironments } from '../runtime/environments'
import { RuntimeClientError } from '../runtime/types'

export type FanOutEnvironment = {
  id: string
  name: string
  /** What the store last learned; the answer's own `_meta.runtimeId` wins when there is one. */
  runtimeId: string | null
}

export type FanOutClient = {
  call<TResult>(
    method: 'projectHostSetup.list',
    params?: unknown
  ): Promise<{ result: TResult; _meta?: { runtimeId?: string } }>
}

export type UnansweredOutcome = 'unreachable' | 'unauthorized' | 'unsupported-by-host' | 'failed'

type SetupsListResult = {
  setups: ProjectHostSetupWithReplicaTopology[]
  identityCollisions?: ProjectIdentityCollision[]
}

export type FanOutAnsweredEntry = {
  outcome: 'answered'
  environment: string
  /** Other saved environments that reach this same runtime. */
  alsoReachedAs?: string[]
  runtimeId: string | null
  setups: ProjectHostSetupWithReplicaTopology[]
  identityCollisions?: ProjectIdentityCollision[]
}

export type FanOutUnansweredEntry = {
  outcome: UnansweredOutcome
  environment: string
  runtimeId: string | null
  /** Only for `failed`: a closed-shape error code, never the message. */
  code?: string
}

export type FanOutEntry = FanOutAnsweredEntry | FanOutUnansweredEntry

export type FanOutListing = {
  /** Empty-vs-unknown: no saved environment is its own status, never an empty `queried` success. */
  status: 'no-saved-environments' | 'queried'
  entries: FanOutEntry[]
  /** Names of every environment that was asked, answered or not. */
  queried: string[]
}

export type FanOutDeps = {
  listEnvironments: () => readonly FanOutEnvironment[]
  createClient: (environmentSelector: string, timeoutMs: number) => FanOutClient
  timeoutMs: number
}

// Why: a code outside this table is `failed`; mapping it to a friendlier word would hide a new cause.
export const FAN_OUT_ERROR_CODE_OUTCOMES: ReadonlyMap<
  string,
  Exclude<UnansweredOutcome, 'failed'>
> = new Map([
  ['remote_runtime_unavailable', 'unreachable'],
  ['runtime_unavailable', 'unreachable'],
  ['runtime_timeout', 'unreachable'],
  ['runtime_rpc_queue_overloaded', 'unreachable'],
  ['reconnecting', 'unreachable'],
  ['timeout', 'unreachable'],
  ['unauthorized', 'unauthorized'],
  ['method_not_found', 'unsupported-by-host'],
  ['incompatible_runtime', 'unsupported-by-host']
])

const SAFE_ERROR_CODE = /^[a-z][a-z0-9_.-]{0,63}$/

/** A paired host chooses its own error code; print only a plain identifier of it. */
function safeErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : 'unknown_error'
}

function classifyError(
  error: unknown
): { outcome: Exclude<UnansweredOutcome, 'failed'> } | { outcome: 'failed'; code: string } {
  const code = safeErrorCode(error)
  const outcome = FAN_OUT_ERROR_CODE_OUTCOMES.get(code)
  return outcome ? { outcome } : { outcome: 'failed', code }
}

class FanOutTimeoutError extends Error {
  readonly code = 'runtime_timeout'
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new FanOutTimeoutError('runtime did not answer')), timeoutMs)
  })
  try {
    return await Promise.race([work, expiry])
  } finally {
    clearTimeout(timer)
  }
}

async function queryEnvironment(
  environment: FanOutEnvironment,
  deps: FanOutDeps
): Promise<FanOutEntry> {
  try {
    const client = deps.createClient(environment.id, deps.timeoutMs)
    const response = await withTimeout(
      client.call<SetupsListResult>('projectHostSetup.list'),
      deps.timeoutMs
    )
    return {
      outcome: 'answered',
      environment: environment.name,
      runtimeId: response._meta?.runtimeId ?? environment.runtimeId,
      setups: response.result.setups,
      ...(response.result.identityCollisions
        ? { identityCollisions: response.result.identityCollisions }
        : {})
    }
  } catch (error) {
    return {
      ...classifyError(error),
      environment: environment.name,
      runtimeId: environment.runtimeId
    }
  }
}

/** Entries are keyed by (runtime, setup id): one runtime reached twice contributes each setup once. */
function mergeSameRuntime(entries: readonly FanOutEntry[]): FanOutEntry[] {
  const merged: FanOutEntry[] = []
  const answeredByRuntime = new Map<string, FanOutAnsweredEntry>()
  for (const entry of entries) {
    if (entry.outcome !== 'answered' || entry.runtimeId === null) {
      merged.push(entry)
      continue
    }
    const existing = answeredByRuntime.get(entry.runtimeId)
    if (!existing) {
      const copy: FanOutAnsweredEntry = { ...entry, setups: [...entry.setups] }
      answeredByRuntime.set(entry.runtimeId, copy)
      merged.push(copy)
      continue
    }
    existing.alsoReachedAs = [...(existing.alsoReachedAs ?? []), entry.environment]
    const known = new Set(existing.setups.map((setup) => setup.id))
    for (const setup of entry.setups) {
      if (!known.has(setup.id)) {
        existing.setups.push(setup)
      }
    }
  }
  return merged
}

/** Read-only: asks each saved environment `projectHostSetup.list` and nothing else. */
export async function listSetupsAcrossEnvironments(deps: FanOutDeps): Promise<FanOutListing> {
  const environments = deps.listEnvironments()
  if (environments.length === 0) {
    return { status: 'no-saved-environments', entries: [], queried: [] }
  }
  // Why: queryEnvironment never rejects, so one slow or failing runtime cannot hold up or sink the rest.
  const entries = await Promise.all(
    environments.map((environment) => queryEnvironment(environment, deps))
  )
  return {
    status: 'queried',
    entries: mergeSameRuntime(entries),
    queried: environments.map((environment) => environment.name)
  }
}

/** The fan-out picks its own targets, so an explicit target is a contradiction, not a filter. */
function refuseExplicitTarget(flags: Map<string, string | boolean>): void {
  for (const other of ['environment', 'pairing-code']) {
    if (flags.has(other)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--all-environments queries every saved environment and cannot be combined with --${other}.`
      )
    }
  }
}

export async function runProjectSetupsAllEnvironments(
  ctx: { flags: Map<string, string | boolean>; json: boolean },
  deps: FanOutDeps
): Promise<void> {
  // Why: refuse before listing environments or building any client, so no credential is touched.
  refuseExplicitTarget(ctx.flags)
  const projectFilter = getOptionalStringFlag(ctx.flags, 'project')
  const hostFilter = getOptionalStringFlag(ctx.flags, 'host')
  const listing = await listSetupsAcrossEnvironments(deps)
  const filtered: FanOutListing = {
    ...listing,
    entries: listing.entries.map((entry) =>
      entry.outcome === 'answered'
        ? {
            ...entry,
            setups: entry.setups.filter(
              (setup) =>
                (projectFilter === undefined || setup.projectId === projectFilter) &&
                (hostFilter === undefined || setup.hostId === hostFilter)
            )
          }
        : entry
    )
  }
  console.log(
    ctx.json
      ? JSON.stringify({ ok: true, result: filtered }, null, 2)
      : formatFanOutListing(filtered)
  )
}

// Why: a runtime that stays silent past this bound becomes an `unreachable` entry instead of stalling the listing.
const FAN_OUT_RUNTIME_TIMEOUT_MS = 15_000

export function savedEnvironmentFanOut(): FanOutDeps {
  const userDataPath = getDefaultUserDataPath()
  return {
    // Why: only id, name and runtime id leave the store record; the pairing credential never does.
    listEnvironments: () =>
      listEnvironments(userDataPath).map(({ id, name, runtimeId }) => ({ id, name, runtimeId })),
    // Why: a null pairing code stops ORCA_PAIRING_CODE from leaking into a per-environment client.
    createClient: (selector, timeoutMs) =>
      new RuntimeClient(userDataPath, timeoutMs, null, selector),
    timeoutMs: FAN_OUT_RUNTIME_TIMEOUT_MS
  }
}
