/** What a task declares it needs, what the executing host reports, and the admission that joins them. */
import type { HostAvailableMemorySource } from '../../../shared/process-stats-types'


export const DISPATCH_ADMISSION_SCHEMA = 'orca.dispatch-admission/1'

// Why 60s: the observation is taken at dispatch time by the same tick, so anything older means the
// probe result was carried across ticks and no longer describes the host we are about to load.
export const DEFAULT_MAX_OBSERVATION_AGE_MS = 60_000

export type DispatchResourceRequirement = {
  minAvailableMemoryBytes: number
}

export type DispatchRequirementParse =
  | { kind: 'none'; strippedSpec: string }
  | { kind: 'declared'; requirement: DispatchResourceRequirement; strippedSpec: string }
  | { kind: 'malformed'; detail: string; strippedSpec: string }

// Reuses the estate's own reading provenance rather than restating it: one vocabulary for
// "how well do we know this number", shared with the memory snapshot surface.
export type HostObservationSource = HostAvailableMemorySource

export type DispatchHostObservation = {
  availableMemoryBytes: number
  source: HostObservationSource
  observedAt: string
}

// "Could not ask" and "asked and got nothing" are different evidence; only one is fixed by
// teaching the runtime to answer. Collapsing them hides which.
export type DispatchObservationResult =
  | { kind: 'observed'; observation: DispatchHostObservation }
  | {
      kind: 'unobservable'
      cause: 'no-capability' | 'executor-unknown' | 'executor-not-local'
      detail: string
    }
  | { kind: 'unavailable'; detail: string }

export type DispatchRefusalReason =
  | 'requirement-malformed'
  | 'executor-unobservable'
  | 'observation-unavailable'
  | 'observation-stale'
  | 'insufficient-available-memory'

export type DispatchAdmissionEnvelope = {
  schema: typeof DISPATCH_ADMISSION_SCHEMA
  reason: 'no-requirement-declared' | 'requirement-satisfied'
  requirement: DispatchResourceRequirement | null
  observation: DispatchHostObservation | null
  decidedAt: string
}

export type DispatchAdmission =
  | { verdict: 'admitted'; envelope: DispatchAdmissionEnvelope }
  | { verdict: 'refused'; reason: DispatchRefusalReason; detail: string }

const DECLARATION_KEY = 'min-available-memory'
const DECLARATION_RE = new RegExp(`^[ \\t]*${DECLARATION_KEY}:[ \\t]*(.*?)[ \\t]*$`, 'i')
const FENCE_RE = /^[ \t]*(```|~~~)/

// SI for KB/MB/GB, IEC for KiB/MiB/GiB. Both spellings are unambiguous as written, so the author
// chose the scale -- which is the point: a bare number would be us guessing.
const UNIT_BYTES: Record<string, number> = {
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4
}

const VALUE_RE = /^(\d+(?:\.\d+)?)[ \t]*([a-z]+)$/i

function parseByteQuantity(raw: string): { bytes: number } | { error: string } {
  if (!raw) {
    return { error: `${DECLARATION_KEY} was declared with no value` }
  }
  const match = VALUE_RE.exec(raw)
  if (!match) {
    return {
      error: `${DECLARATION_KEY}: "${raw}" is not a quantity with an explicit unit (e.g. 512MB, 8GiB)`
    }
  }
  const scale = UNIT_BYTES[match[2].toLowerCase()]
  if (scale === undefined) {
    return { error: `${DECLARATION_KEY}: "${match[2]}" is not a known unit` }
  }
  const bytes = Number(match[1]) * scale
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > Number.MAX_SAFE_INTEGER) {
    return { error: `${DECLARATION_KEY}: "${raw}" is not a positive, representable size` }
  }
  return { bytes: Math.round(bytes) }
}

/**
 * Reads the requirement out of a task spec and strips it, so the worker never reads an infra line
 * as instruction. Unlike the allow-stale-base flag this models a REQUIREMENT, so the defaults
 * invert: a line inside a fenced block is documentation and declares nothing, and a line that was
 * meant as a declaration but cannot be read is malformed rather than absent -- a typo must not be
 * the thing that grants admission.
 */
export function parseDispatchResourceRequirement(spec: string): DispatchRequirementParse {
  const lines = spec.split('\n')
  const kept: string[] = []
  const found: string[] = []
  let fenced = false

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      fenced = !fenced
      kept.push(line)
      continue
    }
    const match = fenced ? null : DECLARATION_RE.exec(line.replace(/\r$/, ''))
    if (match) {
      found.push(match[1])
      continue
    }
    kept.push(line)
  }

  const strippedSpec = kept.join('\n')
  if (found.length === 0) {
    return { kind: 'none', strippedSpec: spec }
  }
  if (found.length > 1) {
    return {
      kind: 'malformed',
      detail: `${DECLARATION_KEY} is declared ${found.length} times; which one binds is not decidable`,
      strippedSpec
    }
  }
  const quantity = parseByteQuantity(found[0])
  if ('error' in quantity) {
    return { kind: 'malformed', detail: quantity.error, strippedSpec }
  }
  return {
    kind: 'declared',
    requirement: { minAvailableMemoryBytes: quantity.bytes },
    strippedSpec
  }
}

export function decideDispatchAdmission(params: {
  parse: DispatchRequirementParse
  observation: DispatchObservationResult
  now: Date
  maxObservationAgeMs?: number
}): DispatchAdmission {
  const { parse, observation, now } = params
  const maxAge = params.maxObservationAgeMs ?? DEFAULT_MAX_OBSERVATION_AGE_MS
  const decidedAt = now.toISOString()

  if (parse.kind === 'malformed') {
    return { verdict: 'refused', reason: 'requirement-malformed', detail: parse.detail }
  }

  if (parse.kind === 'none') {
    // Intentional, and the only state that admits without evidence: nothing was asked for, so
    // there is nothing to establish. Absence of a DECLARATION is not absence of an ANSWER.
    return {
      verdict: 'admitted',
      envelope: {
        schema: DISPATCH_ADMISSION_SCHEMA,
        reason: 'no-requirement-declared',
        requirement: null,
        observation: observation.kind === 'observed' ? observation.observation : null,
        decidedAt
      }
    }
  }

  if (observation.kind === 'unobservable') {
    return { verdict: 'refused', reason: 'executor-unobservable', detail: observation.detail }
  }
  if (observation.kind === 'unavailable') {
    return { verdict: 'refused', reason: 'observation-unavailable', detail: observation.detail }
  }

  const { availableMemoryBytes, observedAt } = observation.observation
  if (!Number.isFinite(availableMemoryBytes) || availableMemoryBytes < 0) {
    return {
      verdict: 'refused',
      reason: 'observation-unavailable',
      detail: `host reported ${availableMemoryBytes} available bytes, which is not a reading`
    }
  }

  const observedMs = Date.parse(observedAt)
  if (!Number.isFinite(observedMs)) {
    return {
      verdict: 'refused',
      reason: 'observation-unavailable',
      detail: `host observation carries an unreadable timestamp "${observedAt}"`
    }
  }
  // Clamp skew: an observation that looks fresher than now is not stale, and this is the one
  // direction a freshness check must not fail in.
  const ageMs = Math.max(0, now.getTime() - observedMs)
  if (ageMs > maxAge) {
    return {
      verdict: 'refused',
      reason: 'observation-stale',
      detail: `host observation is ${ageMs}ms old, past the ${maxAge}ms bound`
    }
  }

  const required = parse.requirement.minAvailableMemoryBytes
  if (availableMemoryBytes < required) {
    return {
      verdict: 'refused',
      reason: 'insufficient-available-memory',
      detail: `task requires ${required} bytes available; host reports ${availableMemoryBytes} (${observation.observation.source})`
    }
  }

  return {
    verdict: 'admitted',
    envelope: {
      schema: DISPATCH_ADMISSION_SCHEMA,
      reason: 'requirement-satisfied',
      requirement: parse.requirement,
      observation: observation.observation,
      decidedAt
    }
  }
}

export type DispatchHostProbe = (handle: string) => Promise<DispatchObservationResult>

/**
 * The one door both production dispatch paths cross. A runtime that cannot answer yields
 * `unobservable` rather than a permissive default: an optional capability is fail-open only when
 * its absence is read as permission, and here absence is read as ignorance.
 */
export async function admitDispatch(params: {
  spec: string
  targetHandle: string
  probe?: DispatchHostProbe
  now?: Date
  maxObservationAgeMs?: number
}): Promise<{ admission: DispatchAdmission; strippedSpec: string }> {
  const parse = parseDispatchResourceRequirement(params.spec)
  const observation = await observeDispatchHost(params.probe, params.targetHandle)
  const admission = decideDispatchAdmission({
    parse,
    observation,
    now: params.now ?? new Date(),
    ...(params.maxObservationAgeMs === undefined
      ? {}
      : { maxObservationAgeMs: params.maxObservationAgeMs })
  })
  return { admission, strippedSpec: parse.strippedSpec }
}

export async function observeDispatchHost(
  probe: DispatchHostProbe | undefined,
  handle: string
): Promise<DispatchObservationResult> {
  if (!probe) {
    return {
      kind: 'unobservable',
      cause: 'no-capability',
      detail: `runtime cannot observe host resources for ${handle}`
    }
  }
  try {
    return await probe(handle)
  } catch (err) {
    return {
      kind: 'unavailable',
      detail: `host resource probe failed for ${handle}: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

export function describeDispatchRefusal(
  taskId: string,
  refusal: Extract<DispatchAdmission, { verdict: 'refused' }>
): string {
  return `Refusing to dispatch ${taskId} [${refusal.reason}]: ${refusal.detail}`
}
