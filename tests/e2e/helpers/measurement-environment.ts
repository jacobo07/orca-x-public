import { freemem, totalmem } from 'node:os'

/**
 * Is this host fit to have a latency number published from it?
 *
 * A load generator is part of the system under test. When the machine is short of memory, a timing
 * measurement stops being about the feature and starts being about the machine — and the resulting
 * numbers read exactly like feature numbers, which is what makes them dangerous rather than merely
 * useless. So a timing claim is gated on this, and a failure here is neither a pass nor a fail for
 * the subject: it means the subject was not measured.
 *
 * Deliberately single-signal. Free physical memory is the only pressure signal with a measured
 * dose-response on this host — e2e runs died progressively earlier as headroom fell (~2.2 GB: a test
 * passed; ~1.7 GB: the run died partway; ~1.35 GB: setup died before any test began). A second
 * signal with no measured boundary would be a threshold invented to look thorough. Add one when a
 * run is observed dying with headroom to spare, and bring its dose-response with it.
 */

const BYTES_PER_MB = 1024 * 1024

/**
 * Observed on this host, not a universal constant: runs died below ~1.35 GB and completed near
 * 2.2 GB, so the floor sits above the highest headroom at which a death was seen. Another machine
 * should measure its own and declare it rather than inherit this one.
 */
export const DEFAULT_MEASUREMENT_FLOOR_BYTES = 3_000 * BYTES_PER_MB

export type MemorySample = {
  atMs: number
  freeBytes: number
  totalBytes: number
}

export type MeasurementVerdict = 'valid' | 'invalid-precondition' | 'degraded-mid-run'

export type MeasurementEnvironment = {
  verdict: MeasurementVerdict
  reason: string
  floorBytes: number
  minFreeBytes: number | null
  sampleCount: number
  /** When a run that began fit first fell through the floor. */
  degradedAtMs?: number
}

export function readMeasurementFloorBytes(env: Record<string, string | undefined>): number {
  const declared = Number(env.ORCA_MEASUREMENT_FLOOR_MB)
  // Why not `|| default`: a host declaring a floor of 0 means "do not gate", and that is a
  // different statement from declaring nothing. NaN and negatives are neither, so they fall back.
  if (!Number.isFinite(declared) || declared < 0) {
    return DEFAULT_MEASUREMENT_FLOOR_BYTES
  }
  return declared * BYTES_PER_MB
}

/**
 * Read in-process rather than through a shell: a sampler taken during a timing run must not itself
 * spawn a process. Calibrated against Win32_OperatingSystem.FreePhysicalMemory on this host —
 * 1320 MB vs 1345 MB, inside 2% — so the dose-response above transfers to this reading.
 */
export function readMemorySample(): MemorySample {
  return { atMs: Date.now(), freeBytes: freemem(), totalBytes: totalmem() }
}

export function evaluateMeasurementEnvironment({
  samples,
  floorBytes
}: {
  samples: MemorySample[]
  floorBytes: number
}): MeasurementEnvironment {
  // An empty set passes `every()` vacuously, so a sampler that never ran would otherwise report
  // exactly what a healthy host reports. Unmeasured is not valid.
  if (samples.length === 0) {
    return {
      verdict: 'invalid-precondition',
      reason: 'no samples: the measurement environment was never observed',
      floorBytes,
      minFreeBytes: null,
      sampleCount: 0
    }
  }

  const minFreeBytes = Math.min(...samples.map((sample) => sample.freeBytes))
  const base = { floorBytes, minFreeBytes, sampleCount: samples.length }

  const [opening] = samples
  if (opening.freeBytes < floorBytes) {
    // Recovering later cannot retroactively make the opening fit, and the earliest samples are the
    // ones a run leans on hardest.
    return {
      ...base,
      verdict: 'invalid-precondition',
      reason: `host opened below the floor at ${asMb(opening.freeBytes)} MB free`
    }
  }

  const degraded = samples.find((sample) => sample.freeBytes < floorBytes)
  if (degraded) {
    return {
      ...base,
      verdict: 'degraded-mid-run',
      reason: `host fell to ${asMb(degraded.freeBytes)} MB free during the run`,
      degradedAtMs: degraded.atMs
    }
  }

  return {
    ...base,
    verdict: 'valid',
    reason: `host held at or above ${asMb(minFreeBytes)} MB free throughout`
  }
}

export function describeMeasurementEnvironment(result: MeasurementEnvironment): string {
  const floor = `floor=${asMb(result.floorBytes)}MB`
  const low =
    result.minFreeBytes === null ? 'minFree=n/a' : `minFree=${asMb(result.minFreeBytes)}MB`
  return `[measurement-environment] ${result.verdict} ${floor} ${low} samples=${result.sampleCount} — ${result.reason}`
}

function asMb(bytes: number): number {
  return Math.round(bytes / BYTES_PER_MB)
}
