import { readFileSync } from 'node:fs'
import { parse } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'
import { evaluateSummary, loadManifest, planLines } from './combined-tree-gate-contract.mjs'

const RAW = readFileSync(new URL('../combined-tree-gate.jsonc', import.meta.url), 'utf8')
const MANIFEST = loadManifest(RAW)
const SHA = '0123456789abcdef0123456789abcdef01234567'

function greenLines(manifest = MANIFEST) {
  return [
    'CTG_START fixture 2026-10-03T00:00:00Z',
    `HEAD=${SHA} dirty=0`,
    'LOCK_OK 0e3e7a3189836879',
    'MEM_AVAILABLE_GB=53',
    'PREFLIGHT_OK',
    `BUILD_real_EXIT=0 head=${SHA.slice(0, 9)} dirty=0`,
    ...manifest.specs.map(
      (s) =>
        `SPEC_RESULT ${s.name} label=real exit=0 verdict=PRODUCT_RUN  ${s.minPassed} passed (1.0m);`
    ),
    ...manifest.unitGroups.flatMap((g) => [
      `UNIT ${g.name} exit=0  Test Files ${g.minPassedFiles} passed (${g.minPassedFiles}); Tests 9 passed (9);`,
      ...(g.regressionDiff ? [`UNIT_${g.name.toUpperCase()}_REGRESSIONS 0`] : [])
    ]),
    ...manifest.staticGates.map((g) => `GATE ${g.name} exit=0 ok`)
  ]
}

const judge = (lines, manifest = MANIFEST) => evaluateSummary(`${lines.join('\n')}\n`, manifest)
const swap = (lines, prefix, next) => lines.map((l) => (l.startsWith(prefix) ? next : l))
const drop = (lines, prefix) => lines.filter((l) => !l.startsWith(prefix))
const spec = (name, rest) => `SPEC_RESULT ${name} label=real ${rest}`

function expectRed(lines, firstReason, manifest = MANIFEST) {
  const result = judge(lines, manifest)
  expect(result.verdict).toBe('RED')
  expect(result.failures[0]).toBe(firstReason)
}

describe('evaluateSummary: GREEN control', () => {
  it('reads a complete summary built from the committed manifest as GREEN with its HEAD', () => {
    // Arrange
    const lines = greenLines()
    // Act
    const result = judge(lines)
    // Assert
    expect(result).toEqual({ verdict: 'GREEN', head: SHA, failures: [] })
  })

  it('tolerates a failing regression-diffed group only when its known failures are recorded', () => {
    const manifest = {
      ...MANIFEST,
      unitGroups: MANIFEST.unitGroups.map((g) =>
        g.regressionDiff ? { ...g, knownFailures: ['known flake'] } : g
      )
    }
    const lines = swap(
      greenLines(manifest),
      'UNIT pty ',
      'UNIT pty exit=1  Test Files 67 passed (68);'
    )
    expect(judge(lines, manifest).verdict).toBe('GREEN')
  })
})

describe('evaluateSummary: specs by name and floor', () => {
  it('reads a missing spec line as MISSING', () => {
    expectRed(
      drop(greenLines(), 'SPEC_RESULT reload-freeze-frame '),
      'MISSING SPEC_RESULT reload-freeze-frame'
    )
  })

  it.each([
    ['HARNESS_FAILED', 'exit=1 verdict=HARNESS_FAILED '],
    ['NO_RESULT', 'exit=0 verdict=NO_RESULT '],
    ['HEAD_MOVED', 'exit=99 verdict=HEAD_MOVED from=0123456789'],
    ['a failed test', 'exit=1 verdict=PRODUCT_RUN  1 failed; 2 passed (1.0m);'],
    ['a did-not-run test', 'exit=0 verdict=PRODUCT_RUN  1 did not run; 3 passed (1.0m);'],
    ['an interrupted test', 'exit=0 verdict=PRODUCT_RUN  1 interrupted; 3 passed (1.0m);']
  ])('reads a spec with %s as RED naming its line', (_label, rest) => {
    const line = spec('reload-freeze-frame', rest)
    expectRed(swap(greenLines(), 'SPEC_RESULT reload-freeze-frame ', line), line)
  })

  it('reads an all-skipped mission-brief that exited 0 as below its floor', () => {
    const line = spec('mission-brief', 'exit=0 verdict=PRODUCT_RUN  2 skipped (3.1s);')
    expectRed(
      swap(greenLines(), 'SPEC_RESULT mission-brief ', line),
      'FLOOR SPEC_RESULT mission-brief passed=0 min=2'
    )
  })

  it('reads a duplicated spec plus a missing one as RED although the count is still 14', () => {
    const lines = swap(
      greenLines(),
      'SPEC_RESULT resume-center-open-in ',
      spec('resume-center-snapshots', 'exit=0 verdict=PRODUCT_RUN  1 passed (1.0m);')
    )
    expect(lines.filter((l) => l.startsWith('SPEC_RESULT ')).length).toBe(14)
    expectRed(lines, 'DUPLICATE SPEC_RESULT resume-center-snapshots')
    expect(judge(lines).failures).toContain('MISSING SPEC_RESULT resume-center-open-in')
  })

  it('reads an unexpected spec name as RED', () => {
    const lines = [
      ...greenLines(),
      spec('not-in-manifest', 'exit=0 verdict=PRODUCT_RUN  1 passed (1.0m);')
    ]
    expectRed(lines, 'UNEXPECTED SPEC_RESULT not-in-manifest')
  })
})

describe('evaluateSummary: static gates', () => {
  it('reads 8 of 9 gates as MISSING', () => {
    expectRed(drop(greenLines(), 'GATE oxlint '), 'MISSING GATE oxlint')
  })

  it('reads a gate with exit=1 as RED naming its line', () => {
    const line = 'GATE oxfmt exit=1 Finished in 88ms on 17 files using 20 threads.'
    expectRed(swap(greenLines(), 'GATE oxfmt ', line), line)
  })

  it('reads a duplicated gate as RED', () => {
    expectRed([...greenLines(), 'GATE tsc-web exit=0 ok'], 'DUPLICATE GATE tsc-web')
  })
})

describe('evaluateSummary: unit groups', () => {
  it('reads a missing group as MISSING', () => {
    expectRed(drop(greenLines(), 'UNIT closure '), 'MISSING UNIT closure')
  })

  it('reads a group with exit=1 as RED naming its line', () => {
    const line = 'UNIT gate9 exit=1  Test Files 1 failed | 69 passed (70); Tests 707 passed (708);'
    expectRed(swap(greenLines(), 'UNIT gate9 ', line), line)
  })

  it('reads a group below its passed-file floor as RED', () => {
    const line = 'UNIT gate9 exit=0  Test Files 68 passed (68); Tests 700 passed (700);'
    expectRed(swap(greenLines(), 'UNIT gate9 ', line), 'FLOOR UNIT gate9 passedFiles=68 min=69')
  })

  it.each([
    ['UNIT_PTY_REGRESSIONS 1'],
    ['UNIT_PTY_REGRESSIONS unknown PTY_JSON_UNREADABLE no file']
  ])('reads %s as RED', (line) => {
    expectRed(swap(greenLines(), 'UNIT_PTY_REGRESSIONS', line), line)
  })

  it('reads a missing regressions line as RED', () => {
    expectRed(drop(greenLines(), 'UNIT_PTY_REGRESSIONS'), 'MISSING UNIT_PTY_REGRESSIONS pty')
  })

  it('reads pty exit=1 with no recorded known failures as RED even with 0 regressions', () => {
    const line = 'UNIT pty exit=1  Test Files 67 passed (67); Tests 623 passed (623);'
    expectRed(swap(greenLines(), 'UNIT pty ', line), line)
  })
})

describe('evaluateSummary: header', () => {
  it('reads a dirty HEAD as RED', () => {
    const line = `HEAD=${SHA} dirty=1`
    expectRed(swap(greenLines(), 'HEAD=', line), line)
  })

  it('reads a lockfile mismatch as RED', () => {
    const line = 'LOCK_MISMATCH here=aaaa node_modules_owner=bbbb'
    expectRed(swap(greenLines(), 'LOCK_OK', line), line)
  })

  it('reads a missing build line as RED', () => {
    expectRed(drop(greenLines(), 'BUILD_real_EXIT='), 'MISSING BUILD_real_EXIT')
  })

  it('reads a nonzero build as RED', () => {
    const line = `BUILD_real_EXIT=1 head=${SHA.slice(0, 9)} dirty=0`
    expectRed(swap(greenLines(), 'BUILD_real_EXIT=', line), line)
  })
})

describe('loadManifest', () => {
  const edited = (edit) => {
    const m = parse(RAW)
    edit(m)
    return JSON.stringify(m)
  }

  it.each([
    ['an unknown schema', (m) => (m.schema = 'combined-tree-gate/2'), /schema must be/],
    ['empty specs', (m) => (m.specs = []), /specs must be a non-empty array/],
    ['a duplicate spec', (m) => m.specs.push({ ...m.specs[0] }), /specs: duplicate name/],
    [
      'a duplicate group',
      (m) => m.unitGroups.push({ ...m.unitGroups[0] }),
      /unitGroups: duplicate name/
    ],
    [
      'a duplicate gate',
      (m) => m.staticGates.push({ ...m.staticGates[0] }),
      /staticGates: duplicate name/
    ],
    ['minPassed 0', (m) => (m.specs[0].minPassed = 0), /minPassed must be an integer >= 1/],
    [
      'an argv token with whitespace',
      (m) => (m.staticGates[0].argv = ['node', 'a b']),
      /token "a b"/
    ],
    ['an argv token with ;', (m) => (m.staticGates[0].argv = ['node', 'x;rm']), /token "x;rm"/],
    ['an unset base', (m) => delete m.changedFilesBase, /changedFilesBase must be/],
    ['a group name with a dash', (m) => (m.unitGroups[0].name = 'gate-9'), /unitGroups\[0\] name/]
  ])('throws for %s', (_label, edit, message) => {
    expect(() => loadManifest(edited(edit))).toThrow(message)
  })

  it('names every violation in one error', () => {
    const raw = edited((m) => {
      m.schema = 'x'
      m.specs[0].minPassed = 0
    })
    expect(() => loadManifest(raw)).toThrow(/schema must be.*minPassed must be/)
  })
})

describe('planLines', () => {
  it('prints one line per spec, group and gate and counts that agree', () => {
    // Arrange / Act
    const lines = planLines(MANIFEST)
    // Assert
    const specs = lines.filter((l) => l.startsWith('PLAN_SPEC '))
    expect(specs.map((l) => l.split(' ')[1])).toEqual(MANIFEST.specs.map((s) => s.name))
    expect(lines.filter((l) => l.startsWith('PLAN_UNIT ')).length).toBe(MANIFEST.unitGroups.length)
    expect(lines.filter((l) => l.startsWith('PLAN_GATE ')).length).toBe(MANIFEST.staticGates.length)
    expect(lines.at(-1)).toBe('PLAN_COUNTS specs=14 units=3 gates=9')
    expect(lines).toContain('PLAN_GATE oxfmt 1 node_modules/.bin/oxfmt --check')
    expect(lines).toContain('PLAN_UNIT pty 67 1 src/main/ipc/pty')
  })
})
