import { describe, expect, it } from 'vitest'
import {
  classifyNodeResourcesStep,
  notAttemptedNodeResources,
  parseNodeResourcesReply
} from './node-resources-observation'

const GB = 1024 ** 3
const reply = () => ({
  schema: 'orca.node-resources/1',
  disk: {
    outcome: 'measured',
    filesystems: [{ path: 'C:\\', totalBytes: 500 * GB, availableBytes: 200 * GB }]
  },
  gpu: {
    outcome: 'measured',
    gpus: [{ name: 'RTX 4000', totalBytes: 20 * GB, freeBytes: 18 * GB }]
  },
  models: {
    outcome: 'measured',
    endpoints: [{ port: 8081, modelIds: ['m1'] }],
    unansweredPorts: []
  }
})
const ok = (runtimeId: string, value: unknown) => ({ kind: 'ok' as const, runtimeId, value })
const hasNumber = (value: unknown): boolean => JSON.stringify(value).match(/\d/) !== null

describe('classifyNodeResourcesStep', () => {
  it('keeps the three readings as sent and stamps the caller start time', () => {
    const result = classifyNodeResourcesStep({
      startedAt: 777,
      statusRuntimeId: 'rt',
      step: ok('rt', reply())
    })
    expect(result).toMatchObject({ startedAt: 777, runtimeId: 'rt' })
    expect(result.disk).toEqual(reply().disk)
    expect(result.gpu).toEqual(reply().gpu)
    expect(result.models).toEqual(reply().models)
  })

  it('reads method_not_found as unsupported with no number anywhere', () => {
    const result = classifyNodeResourcesStep({
      startedAt: 1,
      statusRuntimeId: 'rt',
      step: { kind: 'error', code: 'method_not_found', message: 'nope' }
    })
    for (const family of [result.disk, result.gpu, result.models]) {
      expect(family).toMatchObject({ outcome: 'unknown', reason: 'unsupported' })
    }
    expect(hasNumber([result.disk, result.gpu, result.models])).toBe(false)
    expect(Object.keys(result.disk)).not.toContain('filesystems')
    expect(Object.keys(result.gpu)).not.toContain('gpus')
  })

  it('reads other error codes as rejected and a throw as unreachable', () => {
    const rejected = classifyNodeResourcesStep({
      startedAt: 1,
      statusRuntimeId: 'rt',
      step: { kind: 'error', code: 'internal', message: 'x' }
    })
    const threw = classifyNodeResourcesStep({
      startedAt: 1,
      statusRuntimeId: 'rt',
      step: { kind: 'threw', message: 'boom' }
    })
    expect(rejected.disk).toMatchObject({ reason: 'rejected' })
    expect(threw.gpu).toMatchObject({ reason: 'unreachable' })
  })

  it('does not attribute a reply from another incarnation', () => {
    const result = classifyNodeResourcesStep({
      startedAt: 1,
      statusRuntimeId: 'rt-old',
      step: ok('rt-new', reply())
    })
    for (const family of [result.disk, result.gpu, result.models]) {
      expect(family).toMatchObject({ outcome: 'unknown', reason: 'incarnation-changed' })
    }
  })

  it('marks one bad family malformed without blinding the others', () => {
    const bad = reply()
    bad.gpu = {
      outcome: 'measured',
      gpus: [{ name: 'x', totalBytes: 4, freeBytes: 9 }]
    }
    const parsed = parseNodeResourcesReply(bad)
    expect(parsed.gpu).toMatchObject({ outcome: 'unknown', reason: 'malformed' })
    expect(parsed.disk).toEqual(reply().disk)
    expect(parsed.models).toEqual(reply().models)
  })

  it('rejects a non-object disk and a negative byte count', () => {
    const notObject = { ...reply(), disk: 'x' }
    const negative = {
      ...reply(),
      gpu: { outcome: 'measured', gpus: [{ name: 'x', totalBytes: 4, freeBytes: -1 }] }
    }
    expect(parseNodeResourcesReply(notObject).disk).toMatchObject({ reason: 'malformed' })
    expect(parseNodeResourcesReply(negative).gpu).toMatchObject({ reason: 'malformed' })
    expect(parseNodeResourcesReply(negative).disk).toEqual(reply().disk)
  })

  it('reads a wrong schema string as every family malformed', () => {
    const parsed = parseNodeResourcesReply({ ...reply(), schema: 'orca.node-resources/2' })
    for (const family of [parsed.disk, parsed.gpu, parsed.models]) {
      expect(family).toMatchObject({ outcome: 'unknown', reason: 'malformed' })
    }
  })

  it('carries a host-declared unknown arm through and refuses an unrecognised reason', () => {
    const parsed = parseNodeResourcesReply({
      ...reply(),
      gpu: { outcome: 'unknown', reason: 'no-gpu-tool' },
      models: { outcome: 'unknown', reason: 'because' }
    })
    expect(parsed.gpu).toEqual({ outcome: 'unknown', reason: 'no-gpu-tool' })
    expect(parsed.models).toMatchObject({ reason: 'malformed' })
  })

  it('builds a not-attempted observation carrying no measurement', () => {
    const result = notAttemptedNodeResources(5, 'rt', 'status failed')
    expect(result).toMatchObject({ startedAt: 5, runtimeId: 'rt' })
    expect(result.disk).toMatchObject({ outcome: 'unknown', reason: 'not-attempted' })
  })
})
