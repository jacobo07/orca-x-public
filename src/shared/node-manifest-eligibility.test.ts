import { describe, expect, it } from 'vitest'
import { NODE_MANIFEST_SCHEMA, type NodeManifest } from './node-manifest'
import { judgeNodeEligibility, type NodeRequirement } from './node-manifest-eligibility'

const GIB = 1024 ** 3
const T0 = 1_000_000
const MAX = 60_000

type Measurements = NodeManifest['measurements']

function manifestAt(measuredAt: number, overrides: Partial<Measurements> = {}): NodeManifest {
  const base = (v: unknown) => ({
    status: 'measured' as const,
    value: v,
    measured_at: measuredAt,
    max_age_ms: MAX,
    source: 'test'
  })
  return {
    schema: NODE_MANIFEST_SCHEMA,
    observed_at: measuredAt,
    node: {
      address: 'a',
      label: 'a',
      fingerprint: 'fp',
      runtime_id: 'rt',
      platform: 'linux',
      capabilities: []
    },
    measurements: {
      memory: base({ total_bytes: 32 * GIB, available_bytes: 8 * GIB, available_source: 's' }),
      disk: base({
        filesystems: [{ path: '/', total_bytes: 100 * GIB, available_bytes: 50 * GIB }]
      }),
      vram: base({ gpus: [{ name: 'g', total_bytes: 24 * GIB, free_bytes: 16 * GIB }] }),
      resident_model: base({
        endpoints: [{ port: 8080, model_ids: ['m1'] }],
        unanswered_ports: []
      }),
      ...overrides
    } as Measurements
  }
}

const full: NodeRequirement = {
  memory: { minAvailableBytes: GIB },
  disk: { minAvailableBytes: GIB },
  vram: { minFreeBytes: GIB },
  residentModel: {}
}

describe('judgeNodeEligibility', () => {
  it('fresh manifest is eligible (positive control)', () => {
    const r = judgeNodeEligibility(manifestAt(T0), full, T0)
    expect(r.verdict).toBe('eligible')
  })

  it('a stale memory value is unknown, never eligible', () => {
    const r = judgeNodeEligibility(manifestAt(T0), full, T0 + MAX + 1)
    expect(r.verdict).toBe('unknown')
    if (r.verdict === 'eligible') {
      throw new Error('unreachable')
    }
    expect(r.reasons).toContainEqual(expect.objectContaining({ family: 'memory', cause: 'stale' }))
  })

  it('boundary: max-1 and max are fresh, max+1 is stale', () => {
    expect(judgeNodeEligibility(manifestAt(T0), full, T0 + MAX - 1).verdict).toBe('eligible')
    expect(judgeNodeEligibility(manifestAt(T0), full, T0 + MAX).verdict).toBe('eligible')
    expect(judgeNodeEligibility(manifestAt(T0), full, T0 + MAX + 1).verdict).toBe('unknown')
  })

  it('unknown VRAM is unknown, never 0 GB free', () => {
    const m = manifestAt(T0, { vram: { status: 'unknown', reason: 'no-gpu-tool' } })
    const r = judgeNodeEligibility(m, { vram: { minFreeBytes: GIB } }, T0)
    expect(r.verdict).toBe('unknown')
    if (r.verdict === 'eligible') {
      throw new Error('unreachable')
    }
    expect(r.reasons[0]).toMatchObject({ family: 'vram', cause: 'unmeasured' })
    expect(JSON.stringify(r.reasons)).not.toMatch(/\d{4,}/)
  })

  it('a measured 0 free VRAM is ineligible(insufficient): 0 is representable', () => {
    const m = manifestAt(T0, {
      vram: {
        status: 'measured',
        value: { gpus: [{ name: 'g', total_bytes: GIB, free_bytes: 0 }] },
        measured_at: T0,
        max_age_ms: MAX,
        source: 'test'
      }
    })
    const r = judgeNodeEligibility(m, { vram: { minFreeBytes: 1 } }, T0)
    expect(r.verdict).toBe('ineligible')
    if (r.verdict === 'eligible') {
      throw new Error('unreachable')
    }
    expect(r.reasons[0]).toMatchObject({ family: 'vram', cause: 'insufficient', have: 0, need: 1 })
  })

  it('a definite no beats a maybe and keeps the unknown finding', () => {
    const m = manifestAt(T0, { disk: { status: 'unknown', reason: 'statfs-failed' } })
    const r = judgeNodeEligibility(
      m,
      { memory: { minAvailableBytes: 64 * GIB }, disk: { minAvailableBytes: GIB } },
      T0
    )
    expect(r.verdict).toBe('ineligible')
    if (r.verdict === 'eligible') {
      throw new Error('unreachable')
    }
    expect(r.reasons).toContainEqual(
      expect.objectContaining({ family: 'memory', cause: 'insufficient' })
    )
    expect(r.reasons).toContainEqual(
      expect.objectContaining({ family: 'disk', cause: 'unmeasured' })
    )
  })

  it('a family the requirement does not name never blocks', () => {
    const m = manifestAt(T0, { vram: { status: 'unknown', reason: 'no-gpu-tool' } })
    expect(judgeNodeEligibility(m, { memory: { minAvailableBytes: GIB } }, T0).verdict).toBe(
      'eligible'
    )
  })

  it('empty requirement and unsupported schema are unknown', () => {
    const empty = judgeNodeEligibility(manifestAt(T0), {}, T0)
    expect(empty.verdict).toBe('unknown')
    expect(JSON.stringify(empty)).toContain('empty-requirement')
    const bad = { ...manifestAt(T0), schema: 'orca.node-manifest/99' } as unknown as NodeManifest
    const r = judgeNodeEligibility(bad, full, T0)
    expect(r.verdict).toBe('unknown')
    expect(JSON.stringify(r)).toContain('unsupported-schema-version')
  })

  it('uses the observer clock only: observed_at skew changes nothing', () => {
    const skewed = (delta: number): NodeManifest => ({ ...manifestAt(T0), observed_at: T0 + delta })
    const base = judgeNodeEligibility(manifestAt(T0), full, T0 + 5)
    expect(judgeNodeEligibility(skewed(3_600_000), full, T0 + 5)).toEqual(base)
    expect(judgeNodeEligibility(skewed(-3_600_000), full, T0 + 5)).toEqual(base)
  })

  it('multi-value policy: best GPU, tightest disk, explicit path', () => {
    const gpus = {
      status: 'measured' as const,
      value: {
        gpus: [
          { name: 'a', total_bytes: 8 * GIB, free_bytes: GIB },
          { name: 'b', total_bytes: 24 * GIB, free_bytes: 8 * GIB }
        ]
      },
      measured_at: T0,
      max_age_ms: MAX,
      source: 'test'
    }
    const disks = {
      status: 'measured' as const,
      value: {
        filesystems: [
          { path: '/', total_bytes: 100 * GIB, available_bytes: 50 * GIB },
          { path: '/data', total_bytes: 100 * GIB, available_bytes: 2 * GIB }
        ]
      },
      measured_at: T0,
      max_age_ms: MAX,
      source: 'test'
    }
    const m = manifestAt(T0, { vram: gpus, disk: disks })
    expect(judgeNodeEligibility(m, { vram: { minFreeBytes: 4 * GIB } }, T0).verdict).toBe(
      'eligible'
    )
    const missing = judgeNodeEligibility(m, { disk: { minAvailableBytes: GIB, path: '/nope' } }, T0)
    expect(missing.verdict).toBe('unknown')
    expect(JSON.stringify(missing)).toContain('path-not-measured')
    expect(judgeNodeEligibility(m, { disk: { minAvailableBytes: 4 * GIB } }, T0).verdict).toBe(
      'ineligible'
    )
    expect(
      judgeNodeEligibility(m, { disk: { minAvailableBytes: 40 * GIB, path: '/' } }, T0).verdict
    ).toBe('eligible')
  })

  it('negative age clamps to 0 and is fresh', () => {
    expect(judgeNodeEligibility(manifestAt(T0), full, T0 - 500).verdict).toBe('eligible')
  })

  it('resident model: named model present is eligible, absent is ineligible', () => {
    expect(
      judgeNodeEligibility(manifestAt(T0), { residentModel: { modelId: 'm1' } }, T0).verdict
    ).toBe('eligible')
    const r = judgeNodeEligibility(manifestAt(T0), { residentModel: { modelId: 'zz' } }, T0)
    expect(r.verdict).toBe('ineligible')
    expect(JSON.stringify(r)).toContain('model-not-resident')
  })

  // GEX44 on 2026-10-18: two gguf files on disk, one loaded behind :8081 (docs/dws/remeasure-2026-10-18-model-residency-drill.md).
  describe('available is not resident', () => {
    const residentOnly = (unanswered: number[] = []): Partial<Measurements> => ({
      resident_model: {
        status: 'measured',
        value: {
          endpoints: [{ port: 8081, model_ids: ['qwen3-coder-30b'] }],
          unanswered_ports: unanswered
        },
        measured_at: T0,
        max_age_ms: MAX,
        source: 'test'
      } as Measurements['resident_model']
    })

    it('a model on disk but not loaded is ineligible, the loaded one is eligible', () => {
      const m = manifestAt(T0, residentOnly())
      expect(
        judgeNodeEligibility(m, { residentModel: { modelId: 'qwen3-coder-30b' } }, T0).verdict
      ).toBe('eligible')
      const r = judgeNodeEligibility(m, { residentModel: { modelId: 'qwen3-coder-next' } }, T0)
      expect(r.verdict).toBe('ineligible')
      expect(JSON.stringify(r)).toContain('model-not-resident')
    })

    it('absence is not definite while a probed port did not answer: unknown, never ineligible', () => {
      const r = judgeNodeEligibility(
        manifestAt(T0, residentOnly([8082])),
        { residentModel: { modelId: 'qwen3-coder-next' } },
        T0
      )
      expect(r.verdict).toBe('unknown')
      expect(JSON.stringify(r)).toContain('unmeasured')
    })
  })
})
