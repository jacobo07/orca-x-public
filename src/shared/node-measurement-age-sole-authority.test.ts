import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const AGE_FILE = 'src/shared/node-measurement-age.ts'

// Why: every member is required; a missing file fails the sweep instead of reading as clean.
const SCANNED = [
  'src/shared/fleet-placement.ts',
  'src/shared/fleet-resource-observation.ts',
  'src/shared/node-manifest-eligibility.ts',
  'src/shared/node-manifest.ts',
  'src/shared/node-resources-observation.ts',
  'src/cli/fleet-node-manifest-format.ts'
]

const SECOND_AGE_CHECK = [
  /\bnow\s*-\s*[\w.]*(?:startedAt|measured_at|measuredAt)/,
  />\s*(?:request\.)?maxSampleAgeMs\b/,
  />\s*(?:m\.)?max_age_ms\b/,
  />\s*maxAgeMs\b/
]

function hits(source: string): string[] {
  const clean = source.replace(/\r/g, '')
  return SECOND_AGE_CHECK.filter((re) => re.test(clean)).map((re) => re.source)
}

function readRepo(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

describe('measurement age has one authority', () => {
  it('no scanned fleet module carries its own age subtraction or comparison', () => {
    const report = SCANNED.map((rel) =>
      existsSync(join(ROOT, rel))
        ? { rel, state: hits(readRepo(rel)).length === 0 ? 'clean' : 'second-age-check' }
        : { rel, state: 'missing' }
    )
    expect(report.filter((r) => r.state === 'missing')).toEqual([])
    expect(report.filter((r) => r.state === 'second-age-check')).toEqual([])
    // Why: a rename must not silently drop a member from the sweep.
    expect(report.filter((r) => r.state === 'clean').length).toBe(SCANNED.length)
  })

  it('positive control: the scan finds a synthetic second check and the real authority', () => {
    expect(hits('if (ageMs > request.maxSampleAgeMs) {}').length).toBeGreaterThan(0)
    expect(hits('const age = now - sample.startedAt')).not.toEqual([])
    expect(hits(readRepo(AGE_FILE)).length).toBeGreaterThan(0)
  })
})
