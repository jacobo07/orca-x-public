import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OOB_POWER_REFUSAL_CODES,
  OOB_POWER_RESULT_STAGES,
  type OobPowerController
} from './oob-power'
import { createRecordingOobPowerController } from './oob-power-test-double'

// Why from this file: process.cwd() differs between the root config and an IDE runner.
const SRC_DIR = join(__dirname, '..', '..')
const TEST_FILE = /\.(test|spec)\.tsx?$/
const DOUBLE_MODULE = 'oob-power-test-double'
const CONTRACT_NAME = 'OobPowerController'

type SourceFile = { path: string; text: string }

function walkSources(dir: string, out: SourceFile[]): SourceFile[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') {
        walkSources(full, out)
      }
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push({
        path: relative(SRC_DIR, full).split(sep).join('/'),
        text: readFileSync(full, 'utf8')
      })
    }
  }
  return out
}

const SOURCES = walkSources(SRC_DIR, [])
const PRODUCTION = SOURCES.filter((file) => !TEST_FILE.test(file.path))

describe('OobPowerController contract', () => {
  it('caps a power-on result at command-accepted and names three refusals', () => {
    expect(OOB_POWER_RESULT_STAGES).toEqual(['command-accepted'])
    expect(OOB_POWER_REFUSAL_CODES).toEqual(['oob_unavailable', 'oob_refused', 'oob_unreachable'])
  })

  it('records calls and replays the script through the interface', async () => {
    let clock = 1_000
    const double = createRecordingOobPowerController({
      powerOn: [
        { ok: true, stage: 'command-accepted' },
        { ok: false, code: 'oob_unreachable' }
      ],
      states: ['off', 'unknown'],
      now: () => clock
    })
    const controller: OobPowerController = double

    expect(await controller.powerOn('t1')).toEqual({ ok: true, stage: 'command-accepted' })
    expect(await controller.readPowerState('t1')).toEqual({ state: 'off', observedAt: 1_000 })
    clock = 2_000
    expect(await controller.powerOn('t2')).toEqual({ ok: false, code: 'oob_unreachable' })
    expect(await controller.readPowerState('t2')).toEqual({ state: 'unknown', observedAt: 2_000 })
    expect(double.calls).toEqual([
      { op: 'powerOn', targetId: 't1' },
      { op: 'readPowerState', targetId: 't1' },
      { op: 'powerOn', targetId: 't2' },
      { op: 'readPowerState', targetId: 't2' }
    ])
  })

  it('fails loudly when a test outruns its script', async () => {
    const double = createRecordingOobPowerController({ powerOn: [], states: [], now: () => 0 })
    await expect(double.powerOn('t1')).rejects.toThrow(/script/)
    await expect(double.readPowerState('t1')).rejects.toThrow(/script/)
  })
})

describe('OOB test double reaches no production path', () => {
  it(`walks the whole src tree (station control: ${SOURCES.length} files)`, () => {
    expect(SOURCES.length).toBeGreaterThan(100)
    expect(SOURCES.map((file) => file.path)).toContain('main/index.ts')
  })

  it('sees an import of the double in its own test file (positive control)', () => {
    const importers = SOURCES.filter((file) => file.text.includes(DOUBLE_MODULE)).map(
      (file) => file.path
    )
    expect(importers).toContain('main/runtime/oob-power.test.ts')
  })

  it('finds no non-test file that references the double', () => {
    const importers = PRODUCTION.filter((file) => file.text.includes(DOUBLE_MODULE)).map(
      (file) => file.path
    )
    expect(importers).toEqual([])
  })

  it('finds the contract named only by its declaration and the double', () => {
    const mentions = PRODUCTION.filter((file) => file.text.includes(CONTRACT_NAME))
      .map((file) => file.path)
      .sort()
    expect(mentions).toContain('main/runtime/oob-power-test-double.ts')
    expect(mentions).toEqual(['main/runtime/oob-power-test-double.ts', 'main/runtime/oob-power.ts'])
  })

  it('registers nothing OOB in the main entry', () => {
    const entry = SOURCES.find((file) => file.path === 'main/index.ts')
    expect(entry?.text.includes('oob-power')).toBe(false)
  })
})
