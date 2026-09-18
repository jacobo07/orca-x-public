import { describe, expect, it } from 'vitest'
import { RUNTIME_PROTOCOL_VERSION } from './protocol-version'
import {
  classifyRemoteFleetObservation,
  fleetSampleAgeMs,
  type FleetRpcStep
} from './fleet-resource-observation'

const GB = 1024 ** 3
const status = (runtimeId = 'rt-1', extra: Record<string, unknown> = {}): FleetRpcStep => ({
  kind: 'ok',
  runtimeId,
  value: {
    runtimeId,
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    hostPlatform: 'linux',
    capabilities: ['a.v1'],
    ...extra
  }
})
const memory = (runtimeId = 'rt-1', host: Record<string, unknown> = {}): FleetRpcStep => ({
  kind: 'ok',
  runtimeId,
  value: {
    processSweep: 'measured',
    host: {
      totalMemory: 16 * GB,
      availableMemory: 6 * GB,
      availableMemorySource: 'proc-meminfo',
      ...host
    }
  }
})

describe('remote fleet observation', () => {
  it('measures a host whose status and census came from one incarnation', () => {
    const { sample, facts } = classifyRemoteFleetObservation({
      startedAt: 100,
      status: status(),
      memory: memory()
    })
    expect(sample).toEqual({
      outcome: 'measured',
      runtimeId: 'rt-1',
      startedAt: 100,
      totalMemory: 16 * GB,
      availableMemory: 6 * GB,
      availableMemorySource: 'proc-meminfo',
      processSweep: 'measured'
    })
    expect(facts).toEqual({
      runtimeId: 'rt-1',
      platform: 'linux',
      capabilities: ['a.v1'],
      protocol: 'compatible'
    })
  })

  it('refuses a census from a different incarnation than the status it is paired with', () => {
    const { sample } = classifyRemoteFleetObservation({
      startedAt: 1,
      status: status('rt-1'),
      memory: memory('rt-2')
    })
    expect(sample.outcome).toBe('incarnation-changed')
  })

  it('keeps a failed process sweep as an attribute, since host memory comes from the OS', () => {
    const step = memory()
    const value = { ...(step as { value: Record<string, unknown> }).value, processSweep: 'failed' }
    const { sample } = classifyRemoteFleetObservation({
      startedAt: 1,
      status: status(),
      memory: { kind: 'ok', runtimeId: 'rt-1', value }
    })
    expect(sample).toMatchObject({ outcome: 'measured', processSweep: 'failed' })
  })

  it('reads an older host without a sweep flag as unknown, never as measured', () => {
    const step = memory()
    const { processSweep: _drop, ...value } = (step as { value: Record<string, unknown> }).value
    const { sample } = classifyRemoteFleetObservation({
      startedAt: 1,
      status: status(),
      memory: { kind: 'ok', runtimeId: 'rt-1', value }
    })
    expect(sample).toMatchObject({ outcome: 'measured', processSweep: 'unknown' })
  })

  it('keeps unreachable, rejected and unsupported apart', () => {
    const threw: FleetRpcStep = { kind: 'threw', message: 'ECONNREFUSED' }
    const rejected: FleetRpcStep = { kind: 'error', code: 'runtime_unavailable', message: 'x' }
    const unknown: FleetRpcStep = { kind: 'error', code: 'method_not_found', message: 'x' }
    const run = (s: FleetRpcStep, m: FleetRpcStep | null) =>
      classifyRemoteFleetObservation({ startedAt: 1, status: s, memory: m }).sample.outcome
    expect(run(threw, null)).toBe('unreachable')
    expect(run(rejected, null)).toBe('rejected')
    expect(run(status(), threw)).toBe('unreachable')
    expect(run(status(), rejected)).toBe('rejected')
    expect(run(status(), unknown)).toBe('unsupported')
    expect(run(status(), null)).toBe('not-attempted')
  })

  it('treats a census with impossible numbers as malformed, not as a measurement', () => {
    const run = (host: Record<string, unknown>) =>
      classifyRemoteFleetObservation({
        startedAt: 1,
        status: status(),
        memory: memory('rt-1', host)
      }).sample.outcome
    expect(run({ availableMemory: -1 })).toBe('malformed')
    expect(run({ availableMemory: 17 * GB })).toBe('malformed')
    expect(run({ totalMemory: Number.NaN })).toBe('malformed')
    expect(run({ availableMemory: '6' })).toBe('malformed')
  })

  it('reads unknown facts as unknown rather than guessing', () => {
    const { facts } = classifyRemoteFleetObservation({
      startedAt: 1,
      status: status('rt-1', {
        hostPlatform: 'plan9',
        capabilities: 'all',
        runtimeProtocolVersion: undefined,
        protocolVersion: undefined
      }),
      memory: null
    })
    expect(facts.platform).toBeNull()
    expect(facts.capabilities).toBeNull()
    // Why: absence reads as protocol 0 in the shared evaluator, which a current client blocks.
    expect(facts.protocol).toBe('blocked')
  })

  it('measures age from the start of the observation and never reads skew as fresher', () => {
    expect(fleetSampleAgeMs({ startedAt: 1_000 }, 4_000)).toBe(3_000)
    expect(fleetSampleAgeMs({ startedAt: 5_000 }, 4_000)).toBe(0)
  })
})
