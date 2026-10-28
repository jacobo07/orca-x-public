import { NODE_MANIFEST_SCHEMA, type NodeManifest, type NodeMeasurement } from './node-manifest'
import { isMeasurementStale } from './node-measurement-age'

/**
 * VRAM is judged against the single GPU with the most free bytes (a model must fit one card).
 * Disk with no `path` is judged against the tightest filesystem; an unlisted `path` is unknown.
 */
export type NodeRequirement = {
  memory?: { minAvailableBytes: number }
  disk?: { minAvailableBytes: number; path?: string }
  vram?: { minFreeBytes: number }
  residentModel?: { modelId?: string }
}

export type NodeEligibilityFamily = 'memory' | 'disk' | 'vram' | 'residentModel' | 'manifest'

export type NodeEligibilityFinding = {
  family: NodeEligibilityFamily
  cause:
    | 'unmeasured'
    | 'stale'
    | 'path-not-measured'
    | 'insufficient'
    | 'model-not-resident'
    | 'empty-requirement'
    | 'unsupported-schema-version'
  detail: string
  have?: number
  need?: number
}

export type NodeEligibility =
  | { verdict: 'eligible'; evaluated: NodeEligibilityFamily[] }
  | { verdict: 'ineligible' | 'unknown'; reasons: NodeEligibilityFinding[] }

type Usable<V> = { value: V } | { finding: NodeEligibilityFinding }

function usable<V>(family: NodeEligibilityFamily, m: NodeMeasurement<V>, now: number): Usable<V> {
  if (m.status !== 'measured') {
    return { finding: { family, cause: 'unmeasured', detail: m.reason } }
  }
  // Why: a stale value is never compared, so an old reading cannot pass or fail a requirement.
  if (isMeasurementStale(m.measured_at, m.max_age_ms, now)) {
    return { finding: { family, cause: 'stale', detail: 'measurement older than its max age' } }
  }
  return { value: m.value }
}

function insufficient(
  family: NodeEligibilityFamily,
  have: number,
  need: number
): NodeEligibilityFinding {
  return { family, cause: 'insufficient', detail: 'measured value below requirement', have, need }
}

function judgeFamily(
  manifest: NodeManifest,
  requirement: NodeRequirement,
  family: NodeEligibilityFamily,
  now: number
): NodeEligibilityFinding | null {
  const { measurements } = manifest
  if (family === 'memory' && requirement.memory) {
    const u = usable(family, measurements.memory, now)
    if ('finding' in u) {
      return u.finding
    }
    const need = requirement.memory.minAvailableBytes
    return u.value.available_bytes < need
      ? insufficient(family, u.value.available_bytes, need)
      : null
  }
  if (family === 'disk' && requirement.disk) {
    const u = usable(family, measurements.disk, now)
    if ('finding' in u) {
      return u.finding
    }
    const { minAvailableBytes: need, path } = requirement.disk
    const pool =
      path === undefined
        ? u.value.filesystems
        : u.value.filesystems.filter((fs) => fs.path === path)
    if (pool.length === 0) {
      return { family, cause: 'path-not-measured', detail: path ?? 'no filesystem listed' }
    }
    const have = Math.min(...pool.map((fs) => fs.available_bytes))
    return have < need ? insufficient(family, have, need) : null
  }
  if (family === 'vram' && requirement.vram) {
    const u = usable(family, measurements.vram, now)
    if ('finding' in u) {
      return u.finding
    }
    const need = requirement.vram.minFreeBytes
    const have = Math.max(...u.value.gpus.map((gpu) => gpu.free_bytes))
    return have < need ? insufficient(family, have, need) : null
  }
  if (family === 'residentModel' && requirement.residentModel) {
    const u = usable(family, measurements.resident_model, now)
    if ('finding' in u) {
      return u.finding
    }
    const { modelId } = requirement.residentModel
    if (modelId === undefined || u.value.endpoints.some((e) => e.model_ids.includes(modelId))) {
      return null
    }
    // Why: an endpoint that did not answer may hold the model, so absence is only definite when all answered.
    return u.value.unanswered_ports.length > 0
      ? { family, cause: 'unmeasured', detail: 'some probed ports did not answer' }
      : { family, cause: 'model-not-resident', detail: modelId }
  }
  return null
}

const FAMILIES: NodeEligibilityFamily[] = ['memory', 'disk', 'vram', 'residentModel']
const DEFINITE: ReadonlySet<NodeEligibilityFinding['cause']> = new Set([
  'insufficient',
  'model-not-resident'
])

/** A definite measured no beats a maybe; any stale/unmeasured need is unknown; only all-clear is eligible. */
export function judgeNodeEligibility(
  manifest: NodeManifest,
  requirement: NodeRequirement,
  now: number
): NodeEligibility {
  if (manifest.schema !== NODE_MANIFEST_SCHEMA) {
    return {
      verdict: 'unknown',
      reasons: [
        { family: 'manifest', cause: 'unsupported-schema-version', detail: String(manifest.schema) }
      ]
    }
  }
  const evaluated = FAMILIES.filter((family) => requirement[family] !== undefined)
  if (evaluated.length === 0) {
    return {
      verdict: 'unknown',
      reasons: [{ family: 'manifest', cause: 'empty-requirement', detail: 'no family required' }]
    }
  }
  const reasons: NodeEligibilityFinding[] = []
  for (const family of evaluated) {
    const finding = judgeFamily(manifest, requirement, family, now)
    if (finding) {
      reasons.push(finding)
    }
  }
  if (reasons.length === 0) {
    return { verdict: 'eligible', evaluated }
  }
  return { verdict: reasons.some((r) => DEFINITE.has(r.cause)) ? 'ineligible' : 'unknown', reasons }
}
