import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./check-mobile-capability-aperture.mjs', import.meta.url))

import {
  ALLOWLIST_FLOOR,
  DEFAULT_BASELINE,
  DEFAULT_METHODS_DIR,
  DEFAULT_RPC_FILE,
  POPULATION_FLOOR,
  collectMethodSources,
  evaluateAperture,
  isEntryPoint,
  parseAllowlist,
  parseBaseline,
  parsePopulation
} from './check-mobile-capability-aperture.mjs'

// Synthetic subjects. A drill pinned to a real method has an interest in that method staying
// host-only and decays the day somebody exposes it; these represent the class instead.
const POPULATION = ['alpha.read', 'alpha.write', 'beta.run', 'gamma.only']
const ALLOWLIST = ['alpha.read']
const HOST_ONLY = ['alpha.write', 'beta.run', 'gamma.only']

function run(overrides = {}) {
  return evaluateAperture({
    population: POPULATION,
    allowlist: ALLOWLIST,
    baseline: HOST_ONLY,
    populationFloor: 1,
    allowlistFloor: 1,
    ...overrides
  })
}

const kinds = (result) => result.failures.map((f) => f.kind)

describe('aperture verdict', () => {
  // Green control. Without it, a predicate that flagged everything would satisfy every red
  // assertion below and look like a working detector.
  it('passes when every host-only method is baselined', () => {
    const result = run()
    expect(result.failures).toEqual([])
    expect(result.reachable).toEqual(['alpha.read'])
    expect(result.hostOnly).toEqual(HOST_ONLY)
  })

  it('fails when a new host-only method is not baselined', () => {
    const result = run({ baseline: ['alpha.write', 'beta.run'] })
    expect(kinds(result)).toContain('new-host-only')
    expect(result.newlyHostOnly).toEqual(['gamma.only'])
  })

  it('fails when a baselined method has become reachable from mobile', () => {
    // The whole point of the ratchet: closing a gap must force the list to shrink.
    const result = run({ allowlist: ['alpha.read', 'beta.run'] })
    expect(kinds(result)).toContain('stale-baseline')
    expect(result.staleBaseline).toEqual(['beta.run'])
  })

  it('fails when a baselined method no longer exists', () => {
    const result = run({ baseline: [...HOST_ONLY, 'deleted.method'] })
    expect(kinds(result)).toContain('stale-baseline')
    expect(result.staleBaseline).toEqual(['deleted.method'])
  })

  it('fails when the allowlist names a method the host does not serve', () => {
    // Distinguishes a hole in the enumerator from a dead allowlist entry; both make the
    // percentages below meaningless, so neither may report clean.
    const result = run({ allowlist: ['alpha.read', 'ghost.method'] })
    expect(kinds(result)).toContain('allowed-but-absent')
    expect(result.allowedButAbsent).toEqual(['ghost.method'])
  })

  it('fails when the population sweep matched implausibly little', () => {
    // A sweep that silently stopped matching must not be indistinguishable from a clean estate.
    const result = run({ populationFloor: 999 })
    expect(kinds(result)).toContain('population-floor')
  })

  it('fails when the allowlist parse matched implausibly little', () => {
    const result = run({ allowlistFloor: 999 })
    expect(kinds(result)).toContain('allowlist-floor')
  })

  it('reports an empty host-only set without inventing a failure', () => {
    const result = run({ allowlist: POPULATION, baseline: [] })
    expect(result.hostOnly).toEqual([])
    expect(result.failures).toEqual([])
  })
})

describe('parsers', () => {
  it('reads dotted method names from defineMethod declarations', () => {
    const methods = parsePopulation([])
    expect(methods.size).toBe(0)
  })

  it('ignores comments and blank lines in a baseline', () => {
    expect([...parseBaseline('# note\n\nalpha.write\n  beta.run  \n')]).toEqual([
      'alpha.write',
      'beta.run'
    ])
  })

  it('stops at the end of the allowlist literal', () => {
    const src = [
      "const MOBILE_RPC_METHOD_ALLOWLIST = new Set([",
      "  'alpha.read',",
      "  'beta.run'",
      '])',
      "const SOMETHING_ELSE = ['gamma.only']"
    ].join('\n')
    expect([...parseAllowlist(src)]).toEqual(['alpha.read', 'beta.run'])
  })

  it('raises rather than returning an empty allowlist when the marker is gone', () => {
    expect(() => parseAllowlist('const OTHER = new Set([])')).toThrow(/not found/)
  })
})

// The gate shipped once with a string-compare entry guard. Reached through a Windows junction,
// `process.argv[1]` kept the typed spelling while node resolved the module to its real path, so
// main() never ran: exit 0, zero bytes, indistinguishable from a pass. A gate that cannot fire is
// the one failure mode nothing else in this file could see.
describe('entry-point detection', () => {
  it('matches when argv and the module name the same real file', () => {
    expect(isEntryPoint(SCRIPT, SCRIPT)).toBe(true)
  })

  it('matches when the two spellings of one file differ', () => {
    // realpathSync collapses both sides; a plain string compare returns false here.
    expect(isEntryPoint(path.relative(process.cwd(), SCRIPT), SCRIPT)).toBe(true)
  })

  it('does not match an unrelated file', () => {
    expect(isEntryPoint(DEFAULT_BASELINE, SCRIPT)).toBe(false)
  })

  it('does not match when the process has no script path', () => {
    expect(isEntryPoint(undefined, SCRIPT)).toBe(false)
  })

  it('runs main and prints a verdict when invoked as a script', () => {
    // The direct control for the dead-gate bug: assert the CLI actually produces output. A gate
    // that silently no-ops exits 0 with nothing on stdout, which every other assertion accepts.
    const out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
    expect(out).toMatch(/mobile capability aperture: \d+\/\d+ host RPC methods reachable/)
    expect(out).toMatch(/PASS: no unclassified host-only RPC method/)
  })
})

// Liveness against the real repo: the drill above is synthetic by design, so something must
// confirm the instrument still finds the actual estate. An assertion that passes on an empty
// sweep is the failure this guards.
describe('real estate', () => {
  const population = parsePopulation(collectMethodSources(DEFAULT_METHODS_DIR))
  const allowlist = parseAllowlist(fs.readFileSync(DEFAULT_RPC_FILE, 'utf8'))

  it('finds a plausible host population and allowlist', () => {
    expect(population.size).toBeGreaterThanOrEqual(POPULATION_FLOOR)
    expect(allowlist.size).toBeGreaterThanOrEqual(ALLOWLIST_FLOOR)
  })

  it('anchors on methods that must exist, so a rename goes red instead of finding nothing', () => {
    for (const anchor of ['git.status', 'files.read', 'terminal.stop', 'browser.goto']) {
      expect(population.has(anchor)).toBe(true)
    }
  })

  it('holds the committed baseline green', () => {
    const baseline = parseBaseline(fs.readFileSync(DEFAULT_BASELINE, 'utf8'))
    expect(evaluateAperture({ population, allowlist, baseline }).failures).toEqual([])
  })
})
