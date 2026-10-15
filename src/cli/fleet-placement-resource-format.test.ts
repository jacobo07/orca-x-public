import { describe, expect, it } from 'vitest'
import type { FleetPlacementRejection } from '../shared/fleet-placement'
import type { FleetPlacementViewResult } from '../shared/fleet-placement-view'
import { formatFleetPlacementView } from './fleet-placement-format'

const GB = 1024 ** 3

function resultRejecting(reasons: FleetPlacementRejection[]): FleetPlacementViewResult {
  return {
    status: 'ok',
    request: { now: 1, maxSampleAgeMs: 60_000 },
    observation: {
      observedAt: 0,
      completedAt: 1,
      members: [],
      coverage: { runtimeEnvironments: 1, sshTargets: 'not-enumerated' }
    },
    proposal: {
      decision: 'no-eligible-host',
      selected: null,
      eligible: [],
      rejected: [{ key: 'runtime:h', fingerprint: 'fp-h', addresses: ['runtime:h'], reasons }]
    }
  }
}

const lineFor = (reasons: FleetPlacementRejection[]) =>
  formatFleetPlacementView(resultRejecting(reasons))
    .split('\n')
    .find((line) => line.includes('runtime:h:')) ?? ''

describe('resource rejection sentences', () => {
  it('carries the figures of every definite resource reason', () => {
    expect(
      lineFor([{ reason: 'insufficient-disk', availableBytes: 5 * GB, required: 100 * GB }])
    ).toMatch(/5(\.0)? GB disk free, 100(\.0)? GB required/)
    expect(lineFor([{ reason: 'insufficient-vram', freeBytes: 3 * GB, required: 8 * GB }])).toMatch(
      /3(\.0)? GB VRAM free, 8(\.0)? GB required/
    )
    expect(lineFor([{ reason: 'model-not-resident', modelId: 'qwen3-coder-30b' }])).toContain(
      'model qwen3-coder-30b is not resident'
    )
  })

  it('names the family and the cause of an unknown resource', () => {
    const line = lineFor([
      { reason: 'resource-unknown', family: 'vram', cause: 'stale', detail: 'too old' }
    ])

    expect(line).toContain('vram unknown (stale: too old)')
  })

  it('prints an unrecognized reason from a newer host instead of throwing', () => {
    const newer = { reason: 'quota-exceeded' } as unknown as FleetPlacementRejection

    expect(lineFor([newer])).toContain('unrecognized reason "quota-exceeded"')
  })
})
