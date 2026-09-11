import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MEASUREMENT_FLOOR_BYTES,
  describeMeasurementEnvironment,
  evaluateMeasurementEnvironment,
  readMeasurementFloorBytes,
  readMemorySample
} from './measurement-environment'

const MB = 1024 * 1024
const sample = (freeMb: number, atMs: number) => ({
  atMs,
  freeBytes: freeMb * MB,
  totalBytes: 32_000 * MB
})

describe('evaluateMeasurementEnvironment', () => {
  const floorBytes = 3_000 * MB

  it('is valid when every sample stayed above the floor', () => {
    const result = evaluateMeasurementEnvironment({
      samples: [sample(6_000, 0), sample(5_200, 500), sample(4_100, 1_000)],
      floorBytes
    })

    expect(result.verdict).toBe('valid')
    expect(result.minFreeBytes).toBe(4_100 * MB)
  })

  it('refuses before it starts when the host was never fit', () => {
    const result = evaluateMeasurementEnvironment({
      samples: [sample(1_100, 0), sample(5_000, 500)],
      floorBytes
    })

    // Recovering later does not retroactively make the opening conditions fit: the run began
    // under pressure, so what it observed early is not attributable to the subject.
    expect(result.verdict).toBe('invalid-precondition')
  })

  it('withdraws a run that started fit and then deteriorated', () => {
    const result = evaluateMeasurementEnvironment({
      samples: [sample(5_000, 0), sample(4_000, 500), sample(900, 1_000)],
      floorBytes
    })

    expect(result.verdict).toBe('degraded-mid-run')
    expect(result.degradedAtMs).toBe(1_000)
  })

  it('does not call an unmeasured environment a valid one', () => {
    // The failure mode this closes: a sampler that never ran reports the same empty evidence as a
    // host with nothing wrong, and an empty `every()` is vacuously true.
    const result = evaluateMeasurementEnvironment({ samples: [], floorBytes })

    expect(result.verdict).toBe('invalid-precondition')
    expect(result.reason).toMatch(/no samples/i)
  })

  it('reports the floor it actually judged against, not the default', () => {
    const result = evaluateMeasurementEnvironment({
      samples: [sample(2_000, 0)],
      floorBytes: 1_000 * MB
    })

    expect(result.verdict).toBe('valid')
    expect(result.floorBytes).toBe(1_000 * MB)
  })
})

describe('readMeasurementFloorBytes', () => {
  it('defaults to the floor observed on this host', () => {
    expect(readMeasurementFloorBytes({})).toBe(DEFAULT_MEASUREMENT_FLOOR_BYTES)
  })

  it('lets another host declare its own floor', () => {
    expect(readMeasurementFloorBytes({ ORCA_MEASUREMENT_FLOOR_MB: '512' })).toBe(512 * MB)
  })

  it('ignores a floor that is not a usable number rather than measuring against NaN', () => {
    expect(readMeasurementFloorBytes({ ORCA_MEASUREMENT_FLOOR_MB: 'plenty' })).toBe(
      DEFAULT_MEASUREMENT_FLOOR_BYTES
    )
    expect(readMeasurementFloorBytes({ ORCA_MEASUREMENT_FLOOR_MB: '-8' })).toBe(
      DEFAULT_MEASUREMENT_FLOOR_BYTES
    )
  })
})

describe('readMemorySample', () => {
  it('reads a plausible live sample from the host it runs on', () => {
    const live = readMemorySample()

    expect(live.totalBytes).toBeGreaterThan(0)
    expect(live.freeBytes).toBeGreaterThanOrEqual(0)
    expect(live.freeBytes).toBeLessThanOrEqual(live.totalBytes)
  })
})

describe('describeMeasurementEnvironment', () => {
  it('names the verdict and the numbers behind it', () => {
    const described = describeMeasurementEnvironment(
      evaluateMeasurementEnvironment({
        samples: [sample(5_000, 0), sample(900, 1_000)],
        floorBytes: 3_000 * MB
      })
    )

    expect(described).toContain('degraded-mid-run')
    expect(described).toContain('900')
  })
})
