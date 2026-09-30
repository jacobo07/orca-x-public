import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NodeManifest, NodeManifestsResult } from '../shared/node-manifest'
import { formatNodeManifests, nodeManifestsExitCode } from './fleet-node-manifest-format'

const GB = 1024 ** 3
const OBSERVED_AT = 100_000

function manifest(overrides: Partial<NodeManifest['measurements']> = {}, fingerprint = 'fp-1') {
  return {
    schema: 'orca.node-manifest/1',
    observed_at: OBSERVED_AT,
    node: {
      address: 'runtime:vps',
      label: 'vps',
      fingerprint,
      runtime_id: 'rt',
      platform: 'linux',
      capabilities: []
    },
    measurements: {
      memory: {
        status: 'measured',
        measured_at: OBSERVED_AT - 3_000,
        max_age_ms: 60_000,
        source: 'proc-meminfo',
        value: { total_bytes: 32 * GB, available_bytes: 9 * GB, available_source: 'proc-meminfo' }
      },
      disk: {
        status: 'measured',
        measured_at: OBSERVED_AT - 20_000,
        max_age_ms: 600_000,
        source: 'statfs',
        value: { filesystems: [{ path: '/', total_bytes: 100 * GB, available_bytes: 40 * GB }] }
      },
      vram: { status: 'unknown', reason: 'no-gpu-tool' },
      resident_model: { status: 'unknown', reason: 'unsupported' },
      ...overrides
    }
  } as unknown as NodeManifest
}

const ok = (manifests: NodeManifest[]): NodeManifestsResult => ({
  status: 'ok',
  observedAt: OBSERVED_AT,
  manifests
})

describe('formatNodeManifests', () => {
  it('prints a measured value with its age from the observer time and its trust window', () => {
    const text = formatNodeManifests(ok([manifest()]))
    expect(text).toContain('vps (runtime:vps) — key fp-1')
    expect(text).toMatch(/memory: 9(\.0)? GB available of 32 GB — measured 3s ago, trusted for 60s/)
    expect(text).toMatch(/disk: \/ 40 GB free of 100 GB — measured 20s ago, trusted for 600s/)
  })

  it('prints an unknown family as unknown (<reason>) with no other digit', () => {
    const lines = formatNodeManifests(ok([manifest()])).split('\n')
    for (const [prefix, reason] of [
      ['  vram: ', 'no-gpu-tool'],
      ['  resident model: ', 'unsupported']
    ]) {
      const line = lines.find((entry) => entry.startsWith(prefix))!
      expect(line).toBe(`${prefix}unknown (${reason})`)
      expect(line.replace(reason, '')).not.toMatch(/\d/)
    }
  })

  it('marks a node with no fingerprint as unkeyed', () => {
    const unkeyed = { ...manifest() } as NodeManifest
    unkeyed.node = { ...unkeyed.node, fingerprint: null }
    expect(formatNodeManifests(ok([unkeyed]))).toContain('vps (runtime:vps) — unkeyed')
  })

  it('exits 0 when read and 1 when refused or unavailable, naming the reason', () => {
    expect(nodeManifestsExitCode(ok([]))).toBe(0)
    expect(nodeManifestsExitCode({ status: 'refused', reason: 'remote-caller' })).toBe(1)
    expect(nodeManifestsExitCode({ status: 'unavailable', reason: 'no-fleet-reader' })).toBe(1)
    expect(formatNodeManifests({ status: 'refused', reason: 'remote-caller' })).toContain('refused')
    expect(formatNodeManifests({ status: 'unavailable', reason: 'no-fleet-reader' })).toContain(
      'no fleet reader'
    )
  })

  it('takes the age from the shared authority, with no subtraction of its own', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'cli', 'fleet-node-manifest-format.ts'),
      'utf8'
    ).replace(/\r/g, '')
    expect(source).toContain('measurementAgeMs(')
    expect(source).not.toMatch(/observedAt\s*-|-\s*measurement\.measured_at|now\s*-/)
  })
})
