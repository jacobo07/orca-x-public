import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_OBSERVATION_AGE_MS,
  decideDispatchAdmission,
  parseDispatchResourceRequirement,
  type DispatchObservationResult
} from './dispatch-admission'

const NOW = new Date('2026-09-22T12:00:00.000Z')

function observed(
  availableMemoryBytes: number,
  ageMs = 0,
  source: 'memory-pressure' | 'proc-meminfo' | 'free-memory' = 'proc-meminfo'
): DispatchObservationResult {
  return {
    kind: 'observed',
    observation: {
      availableMemoryBytes,
      source,
      observedAt: new Date(NOW.getTime() - ageMs).toISOString()
    }
  }
}

const GIB = 1024 ** 3

describe('parseDispatchResourceRequirement', () => {
  it('reads an explicit quantity and strips the infra line from the spec', () => {
    const parse = parseDispatchResourceRequirement('do the work\nmin-available-memory: 8GiB\nmore')
    expect(parse).toMatchObject({ kind: 'declared', requirement: { minAvailableMemoryBytes: 8 * GIB } })
    expect(parse.strippedSpec).toBe('do the work\nmore')
  })

  it('keeps SI and IEC apart rather than guessing a scale', () => {
    const si = parseDispatchResourceRequirement('min-available-memory: 8GB')
    const iec = parseDispatchResourceRequirement('min-available-memory: 8GiB')
    expect(si).toMatchObject({ requirement: { minAvailableMemoryBytes: 8_000_000_000 } })
    expect(iec).toMatchObject({ requirement: { minAvailableMemoryBytes: 8 * GIB } })
  })

  it('declares nothing when the spec never mentions it', () => {
    expect(parseDispatchResourceRequirement('just do the work')).toMatchObject({ kind: 'none' })
  })

  // The inherited fail-open from allow-stale-base, not repeated: documentation is not declaration.
  it('ignores a declaration inside a fenced code block', () => {
    const spec = ['explain this:', '```', 'min-available-memory: 8GiB', '```', 'done'].join('\n')
    const parse = parseDispatchResourceRequirement(spec)
    expect(parse.kind).toBe('none')
    expect(parse.strippedSpec).toBe(spec)
  })

  it.each([
    ['a bare number with no unit', 'min-available-memory: 8192'],
    ['an unknown unit', 'min-available-memory: 8 bananas'],
    ['an empty value', 'min-available-memory:'],
    ['a zero requirement', 'min-available-memory: 0GB'],
    ['two conflicting declarations', 'min-available-memory: 1GB\nmin-available-memory: 2GB']
  ])('refuses to read %s as a requirement', (_label, spec) => {
    expect(parseDispatchResourceRequirement(spec).kind).toBe('malformed')
  })
})

describe('decideDispatchAdmission', () => {
  it('admits when nothing was declared', () => {
    const decision = decideDispatchAdmission({
      parse: parseDispatchResourceRequirement('just work'),
      observation: { kind: 'unobservable', cause: 'no-capability', detail: 'no probe' },
      now: NOW
    })
    expect(decision).toMatchObject({ verdict: 'admitted' })
    expect(decision.verdict === 'admitted' && decision.envelope.reason).toBe('no-requirement-declared')
  })

  it('admits a satisfied requirement and seals the observation it judged', () => {
    const decision = decideDispatchAdmission({
      parse: parseDispatchResourceRequirement('min-available-memory: 1GiB'),
      observation: observed(4 * GIB),
      now: NOW
    })
    expect(decision.verdict).toBe('admitted')
    expect(decision.verdict === 'admitted' && decision.envelope).toMatchObject({
      reason: 'requirement-satisfied',
      requirement: { minAvailableMemoryBytes: GIB },
      observation: { availableMemoryBytes: 4 * GIB, source: 'proc-meminfo' }
    })
  })

  // A malformed declaration must not read as an absent one, or a typo grants admission.
  it('refuses a malformed requirement rather than treating it as none', () => {
    const decision = decideDispatchAdmission({
      parse: parseDispatchResourceRequirement('min-available-memory: 8192'),
      observation: observed(64 * GIB),
      now: NOW
    })
    expect(decision).toMatchObject({ verdict: 'refused', reason: 'requirement-malformed' })
  })

  it.each([
    [
      'executor-unobservable',
      { kind: 'unobservable', cause: 'no-capability', detail: 'runtime cannot observe' } as const
    ],
    ['observation-unavailable', { kind: 'unavailable', detail: 'probe threw' } as const]
  ])('refuses a declared requirement when the host cannot be read (%s)', (reason, observation) => {
    const decision = decideDispatchAdmission({
      parse: parseDispatchResourceRequirement('min-available-memory: 1GiB'),
      observation,
      now: NOW
    })
    expect(decision).toMatchObject({ verdict: 'refused', reason })
  })

  it('refuses a stale observation', () => {
    const decision = decideDispatchAdmission({
      parse: parseDispatchResourceRequirement('min-available-memory: 1GiB'),
      observation: observed(64 * GIB, DEFAULT_MAX_OBSERVATION_AGE_MS + 1),
      now: NOW
    })
    expect(decision).toMatchObject({ verdict: 'refused', reason: 'observation-stale' })
  })

  it('treats a clock-skewed future observation as fresh, not stale', () => {
    const decision = decideDispatchAdmission({
      parse: parseDispatchResourceRequirement('min-available-memory: 1GiB'),
      observation: observed(64 * GIB, -5 * DEFAULT_MAX_OBSERVATION_AGE_MS),
      now: NOW
    })
    expect(decision.verdict).toBe('admitted')
  })

  it.each([[Number.NaN], [-1]])('refuses a nonsense reading (%s) as no reading at all', (bytes) => {
    const decision = decideDispatchAdmission({
      parse: parseDispatchResourceRequirement('min-available-memory: 1GiB'),
      observation: observed(bytes),
      now: NOW
    })
    expect(decision).toMatchObject({ verdict: 'refused', reason: 'observation-unavailable' })
  })

  it('refuses when the host has less than the task asked for', () => {
    const decision = decideDispatchAdmission({
      parse: parseDispatchResourceRequirement('min-available-memory: 8GiB'),
      observation: observed(256 * 1024 * 1024),
      now: NOW
    })
    expect(decision).toMatchObject({ verdict: 'refused', reason: 'insufficient-available-memory' })
  })

  // free-memory is the normal Windows source and understates availability, so it is conservative
  // in the refusing direction. Recording it beats refusing every dispatch on the platform.
  it('admits on the degraded source and records which source decided it', () => {
    const decision = decideDispatchAdmission({
      parse: parseDispatchResourceRequirement('min-available-memory: 1GiB'),
      observation: observed(4 * GIB, 0, 'free-memory'),
      now: NOW
    })
    expect(decision.verdict === 'admitted' && decision.envelope.observation?.source).toBe('free-memory')
  })
})
