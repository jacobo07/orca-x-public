import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  TOLERANCES,
  buildEvidence,
  compareReadings,
  parseControlOutput,
  scanForSecrets
} from './dws-node-manifest-evidence.mjs'

const MIB = 1024 * 1024
const GIB = 1024 * MIB

// Captured on GEX44 2026-09-30 (05-RESEARCH Q6): the shape the ssh control script prints.
const CONTROL_TEXT = [
  'CONTROL_BEGIN',
  '2026-09-30T03:07:00Z',
  'CONTROL_FREE',
  '               total        used        free      shared  buff/cache   available',
  'Mem:     67194220544 14180118528  5583679488    12345678 48517427200 53014102016',
  'Swap:    17162039296           0 17162039296',
  'CONTROL_NVIDIA',
  'NVIDIA RTX 4000 SFF Ada Generation, 20475, 16965, 3054',
  'CONTROL_DF',
  'Filesystem        1B-blocks          Used     Available Use% Mounted on',
  '/dev/md2      1870722568192 1741076590592   34543001600  99% /',
  'CONTROL_MODELS',
  '{"object":"list","data":[{"id":"qwen3-coder-30b","object":"model","owned_by":"llamacpp"}]}',
  'CONTROL_SS',
  'LISTEN 0 4096 127.0.0.1:8081 0.0.0.0:*',
  ''
].join('\n')

function control() {
  return parseControlOutput(CONTROL_TEXT)
}

function product(overrides = {}) {
  return {
    memoryAvailableBytes: 53_000_000_000,
    vramFreeBytes: 3054 * MIB,
    diskAvailableBytes: 34_543_001_600,
    modelIds: ['qwen3-coder-30b'],
    ...overrides
  }
}

const base = {
  rung: 'gex44-local-caller',
  headSha: 'a'.repeat(40),
  runtimeIdMatchesServe: true,
  deployed: {
    sha: 'a'.repeat(40),
    artifactSha256Laptop: 'b'.repeat(64),
    artifactSha256Gex44: 'b'.repeat(64)
  },
  utc: { start: '2026-09-30T03:07:00Z', end: '2026-09-30T03:07:05Z' }
}

describe('parseControlOutput', () => {
  it('reads the real GEX44 control text into the four comparable readings', () => {
    expect(control()).toMatchObject({
      valid: true,
      memoryAvailableBytes: 53_014_102_016,
      vramFreeBytes: 3054 * MIB,
      diskAvailableBytes: 34_543_001_600,
      modelIds: ['qwen3-coder-30b']
    })
  })

  it('is wholly unjudged as harness-rewrote-command when the first line is not CONTROL_BEGIN', () => {
    const rewritten = parseControlOutput('rtk.exe: not found\n' + CONTROL_TEXT)
    expect(rewritten).toMatchObject({
      valid: false,
      unjudgedReason: 'harness-rewrote-command',
      memoryAvailableBytes: null,
      vramFreeBytes: null,
      diskAvailableBytes: null,
      modelIds: null
    })
  })

  it('leaves a family null, not 0, when its section is unreadable', () => {
    const broken = parseControlOutput(
      CONTROL_TEXT.replace('53014102016', '[N/A]').replace('20475, 16965, 3054', '[N/A], 1, 2')
    )
    expect(broken.memoryAvailableBytes).toBeNull()
    expect(broken.vramFreeBytes).toBeNull()
    expect(broken.diskAvailableBytes).toBe(34_543_001_600)
  })
})

describe('compareReadings', () => {
  it('MATCHes readings taken seconds apart, within each stated tolerance', () => {
    const result = compareReadings(
      product({
        vramFreeBytes: 3054 * MIB - 200 * MIB,
        diskAvailableBytes: 34_543_001_600 - GIB / 2
      }),
      control()
    )
    expect(result.memory.verdict).toBe('MATCH')
    expect(result.vram.verdict).toBe('MATCH')
    expect(result.disk.verdict).toBe('MATCH')
    expect(result.resident_model.verdict).toBe('MATCH')
  })

  it('DIVERGEs beyond tolerance and states the delta and the tolerance', () => {
    const result = compareReadings(
      product({
        memoryAvailableBytes: 30_000_000_000,
        vramFreeBytes: 3054 * MIB - 300 * MIB,
        diskAvailableBytes: 34_543_001_600 - 2 * GIB,
        modelIds: ['some-other-model']
      }),
      control()
    )
    for (const family of ['memory', 'vram', 'disk', 'resident_model']) {
      expect(result[family].verdict).toBe('DIVERGED')
    }
    expect(result.vram).toMatchObject({
      delta: 300 * MIB,
      tolerance: TOLERANCES.vramFreeBytes.value
    })
    expect(result.memory.tolerance).toBeGreaterThanOrEqual(TOLERANCES.memoryAvailableMinBytes.value)
  })

  it('UNJUDGEs an unknown product value or a missing control value, never MATCH', () => {
    const result = compareReadings(product({ memoryAvailableBytes: null, vramFreeBytes: null }), {
      ...control(),
      diskAvailableBytes: null,
      modelIds: null
    })
    expect(result.memory).toMatchObject({ verdict: 'UNJUDGED', reason: 'product-unknown' })
    expect(result.disk).toMatchObject({ verdict: 'UNJUDGED', reason: 'control-missing' })
    expect(result.resident_model).toMatchObject({ verdict: 'UNJUDGED', reason: 'control-missing' })
  })

  it('UNJUDGEs an unknown-vs-unknown pair', () => {
    const unknownControl = { ...control(), memoryAvailableBytes: null }
    expect(
      compareReadings(product({ memoryAvailableBytes: null }), unknownControl).memory.verdict
    ).toBe('UNJUDGED')
  })

  it('is not vacuous: unrelated numbers diverge, and a reading compared with itself is refused', () => {
    const unrelated = compareReadings(
      product({
        memoryAvailableBytes: 1_000,
        vramFreeBytes: 5,
        diskAvailableBytes: 7,
        modelIds: []
      }),
      control()
    )
    expect(unrelated.memory.verdict).toBe('DIVERGED')
    expect(unrelated.vram.verdict).toBe('DIVERGED')
    const same = control()
    const result = compareReadings(same, same)
    for (const family of ['memory', 'vram', 'disk', 'resident_model']) {
      expect(result[family]).toMatchObject({ verdict: 'UNJUDGED', reason: 'same-operand' })
    }
  })
})

describe('buildEvidence', () => {
  it('records the rung, shas at both ends, bounds, readings and verdicts, tagging measured families', () => {
    const evidence = buildEvidence({
      ...base,
      product: product({ vramFreeBytes: null }),
      control: control()
    })
    expect(evidence).toMatchObject({
      verdict: 'MEASURED',
      rung: 'gex44-local-caller',
      headSha: base.headSha,
      deployed: base.deployed,
      utc: base.utc
    })
    expect(evidence.comparison.memory.verdict).toBe('MATCH')
    expect(evidence.comparison.vram.verdict).toBe('UNJUDGED')
    expect(evidence.planeTags.memory).toBe('GEX44-PROVEN')
    expect(evidence.planeTags.vram).toBeUndefined()
    expect(
      buildEvidence({ ...base, rung: 'fan-out', product: product(), control: control() }).rung
    ).toBe('fan-out')
  })

  it('yields an honest BLOCKED with the rung reached and no plane tag on any value', () => {
    const evidence = buildEvidence({
      ...base,
      rung: 'none',
      rungReached: 'run-created-no-runner',
      blockedReason: 'no route from the laptop to a GEX44 caller',
      product: null,
      control: null
    })
    expect(evidence).toMatchObject({
      verdict: 'BLOCKED',
      rungReached: 'run-created-no-runner',
      blockedReason: 'no route from the laptop to a GEX44 caller'
    })
    expect(evidence.planeTags).toEqual({})
    for (const entry of Object.values(evidence.comparison)) {
      expect(entry.verdict).toBe('UNJUDGED')
    }
  })

  it('refuses when the artifact sha256 differs between the two ends or a HEAD sha is missing', () => {
    const mismatch = { ...base.deployed, artifactSha256Gex44: 'c'.repeat(64) }
    expect(() =>
      buildEvidence({ ...base, deployed: mismatch, product: product(), control: control() })
    ).toThrow(/sha256/)
    expect(() =>
      buildEvidence({ ...base, headSha: '', product: product(), control: control() })
    ).toThrow(/headSha/)
    expect(() =>
      buildEvidence({
        ...base,
        deployed: { ...base.deployed, sha: undefined },
        product: product(),
        control: control()
      })
    ).toThrow(/sha/)
  })

  it('refuses evidence that carries a secret', () => {
    expect(() =>
      buildEvidence({
        ...base,
        notes: ['paired via orca://pair?code=abc'],
        product: product(),
        control: control()
      })
    ).toThrow(/secret/)
  })
})

describe('scanForSecrets', () => {
  it('flags a pairing URL, a code query, a token-looking run and an agent home path', () => {
    expect(scanForSecrets('orca://pair?code=abc').length).toBeGreaterThan(0)
    expect(scanForSecrets('https://host/x?code=abc123').length).toBeGreaterThan(0)
    expect(scanForSecrets(`Authorization: Bearer ${'A1b2'.repeat(20)}`).length).toBeGreaterThan(0)
    expect(scanForSecrets(`token=${'Zy9_'.repeat(20)}`).length).toBeGreaterThan(0)
    expect(scanForSecrets('/home/kobii/.claude/settings.json').length).toBeGreaterThan(0)
    expect(scanForSecrets('/home/kobii/.codex/auth.json').length).toBeGreaterThan(0)
  })

  it('passes the captured GEX44 numbers and the model id', () => {
    expect(scanForSecrets(CONTROL_TEXT)).toEqual([])
    expect(scanForSecrets('qwen3-coder-30b 53014102016 34543001600')).toEqual([])
  })
})

describe('dws-node-manifest-ssh-control.sh', () => {
  const script = readFileSync(
    new URL('./dws-node-manifest-ssh-control.sh', import.meta.url),
    'utf8'
  ).replace(/\r/g, '')
  const commands = script
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))

  it('starts with CONTROL_BEGIN and carries the plain top-level read-only commands', () => {
    expect(commands[0]).toBe('echo CONTROL_BEGIN')
    for (const expected of [
      'free -b',
      'nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free --format=csv,noheader,nounits',
      'df -B1 /',
      'ss -Hltn'
    ]) {
      expect(commands).toContain(expected)
    }
    expect(commands.some((line) => line.startsWith('curl -s -m 3 http://127.0.0.1:'))).toBe(true)
  })

  it('has no nested shell, no sudo, no delete, no redirect, no parameter expansion', () => {
    expect(script).not.toMatch(/sh -c/)
    expect(script).not.toMatch(/sudo/)
    for (const line of commands) {
      expect(line).not.toMatch(/(^|\s)rm(\s|$)/)
      expect(line).not.toMatch(/>|\$\{/)
    }
  })
})
