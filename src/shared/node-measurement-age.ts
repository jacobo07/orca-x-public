// Why: the only place a measurement age is subtracted or compared; observer clock only, clamped at 0.
export function measurementAgeMs(measuredAt: number, now: number): number {
  return Math.max(0, now - measuredAt)
}

// Why: a NaN age compares false against any bound and would read as fresh, so non-finite is stale.
export function isMeasurementStale(measuredAt: number, maxAgeMs: number, now: number): boolean {
  if (!Number.isFinite(measuredAt) || !Number.isFinite(maxAgeMs) || !Number.isFinite(now)) {
    return true
  }
  return measurementAgeMs(measuredAt, now) > maxAgeMs
}
