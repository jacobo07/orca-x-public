import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  evaluateSummary,
  loadManifest,
  mintGateResult,
  mintSpecResult,
  mintUnitResult,
  runCli,
  unitRegressions
} from './combined-tree-gate-contract.mjs'

const RAW = readFileSync(new URL('../combined-tree-gate.jsonc', import.meta.url), 'utf8')
const MANIFEST = loadManifest(RAW)
const SHA = '0123456789abcdef0123456789abcdef01234567'
const MANIFEST_SHA = createHash('sha256').update(RAW).digest('hex').slice(0, 16)
const manifestLine = (sha = MANIFEST_SHA, committed = 1) =>
  `CTG_MANIFEST sha256=${sha} committed=${committed} /runs/t-012345678/manifest.jsonc`

const treeAt = (phase, head = SHA, dirty = 0) => `TREE_AT ${phase} head=${head} dirty=${dirty}`
const treePhases = (manifest) => [
  'build',
  ...manifest.specs.map((s) => `spec-${s.name}`),
  'units',
  'gates',
  'end'
]

function greenLines(manifest = MANIFEST) {
  return [
    'CTG_START fixture 2026-10-03T00:00:00Z',
    `HEAD=${SHA} dirty=0`,
    'LOCK_OK 0e3e7a3189836879',
    manifestLine(),
    'MEM_AVAILABLE_GB=53',
    'PREFLIGHT_OK',
    `BUILD_real_EXIT=0 head=${SHA.slice(0, 9)} dirty=0`,
    ...treePhases(manifest).map((phase) => treeAt(phase)),
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

const judge = (lines, manifest = MANIFEST, sha = MANIFEST_SHA) =>
  evaluateSummary(`${lines.join('\n')}\n`, manifest, sha)
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
    expect(result).toEqual({
      verdict: 'GREEN',
      head: SHA,
      manifest: MANIFEST_SHA,
      committed: true,
      failures: []
    })
  })

  it('tolerates a failing regression-diffed group only when its known failures are recorded', () => {
    const manifest = {
      ...MANIFEST,
      unitGroups: MANIFEST.unitGroups.map((g) =>
        g.regressionDiff ? { ...g, knownFailures: ['a.test.ts::known flake'] } : g
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
    ['an interrupted test', 'exit=0 verdict=PRODUCT_RUN  1 interrupted; 3 passed (1.0m);'],
    ['a flaky test', 'exit=0 verdict=PRODUCT_RUN  1 flaky; 3 passed (1.0m);']
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

  it('reads a regressions line for a group that is not regression-diffed as RED', () => {
    expectRed([...greenLines(), 'UNIT_GATE9_REGRESSIONS 0'], 'UNEXPECTED UNIT_GATE9_REGRESSIONS')
  })

  it('reads a missing regressions line as RED', () => {
    expectRed(drop(greenLines(), 'UNIT_PTY_REGRESSIONS'), 'MISSING UNIT_PTY_REGRESSIONS pty')
  })

  it.each(['124', '2', '137'])(
    'reads a regression-diffed group that exited %s as RED although known failures are recorded (WR-10)',
    (code) => {
      const manifest = {
        ...MANIFEST,
        unitGroups: MANIFEST.unitGroups.map((g) =>
          g.regressionDiff ? { ...g, knownFailures: ['a.test.ts::known flake'] } : g
        )
      }
      const line = `UNIT pty exit=${code}  Test Files 67 passed (67); Tests 623 passed (623);`
      expectRed(swap(greenLines(manifest), 'UNIT pty ', line), line, manifest)
    }
  )

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

  it('reads a missing LOCK_OK line as RED', () => {
    expectRed(drop(greenLines(), 'LOCK_OK'), 'MISSING LOCK_OK')
  })

  it.each([
    ['another revision', `BUILD_real_EXIT=0 head=${'f'.repeat(9)} dirty=0`],
    ['a dirty tree', `BUILD_real_EXIT=0 head=${SHA.slice(0, 9)} dirty=1`]
  ])('reads a build of %s as RED naming its line', (_label, line) => {
    expectRed(swap(greenLines(), 'BUILD_real_EXIT=', line), line)
  })

  it('reads a nonzero build as RED', () => {
    const line = `BUILD_real_EXIT=1 head=${SHA.slice(0, 9)} dirty=0`
    expectRed(swap(greenLines(), 'BUILD_real_EXIT=', line), line)
  })
})

describe('evaluateSummary: tree assertions (CR-01)', () => {
  it('reads a missing closing TREE_AT as RED', () => {
    expectRed(drop(greenLines(), 'TREE_AT end '), 'MISSING TREE_AT end')
  })

  it('reads a summary with no TREE_AT line at all as RED', () => {
    const result = judge(drop(greenLines(), 'TREE_AT '))
    expect(result.verdict).toBe('RED')
    expect(result.failures).toContain('MISSING TREE_AT spec-mission-brief')
  })

  it.each(['build', 'spec-reload-freeze-frame', 'units', 'gates', 'end'])(
    'reads a TREE_AT %s on another head as RED naming its line',
    (phase) => {
      const line = treeAt(phase, 'f'.repeat(40))
      expectRed(swap(greenLines(), `TREE_AT ${phase} `, line), line)
    }
  )

  it.each(['units', 'end'])('reads a dirty TREE_AT %s as RED naming its line', (phase) => {
    const line = treeAt(phase, SHA, 2)
    expectRed(swap(greenLines(), `TREE_AT ${phase} `, line), line)
  })

  it('reads an unreadable tree state as RED', () => {
    const line = `TREE_AT gates head=unknown dirty=unknown`
    expectRed(swap(greenLines(), 'TREE_AT gates ', line), line)
  })

  it('reads a duplicated or unexpected TREE_AT phase as RED', () => {
    expectRed([...greenLines(), treeAt('end')], 'DUPLICATE TREE_AT end')
    expectRed([...greenLines(), treeAt('lunch')], 'UNEXPECTED TREE_AT lunch')
  })
})

describe('evaluateSummary: manifest identity (WR-01)', () => {
  it('reads a missing CTG_MANIFEST line as RED', () => {
    expectRed(drop(greenLines(), 'CTG_MANIFEST '), 'MISSING CTG_MANIFEST')
  })

  it('reads a CTG_MANIFEST of another manifest than the one judged as RED naming its line', () => {
    const line = manifestLine('f'.repeat(16))
    expectRed(swap(greenLines(), 'CTG_MANIFEST ', line), line)
  })

  it('reads a duplicated or malformed CTG_MANIFEST line as RED', () => {
    expectRed([...greenLines(), manifestLine()], 'DUPLICATE CTG_MANIFEST')
    const bare = `CTG_MANIFEST sha256=${MANIFEST_SHA} /runs/x/manifest.jsonc`
    expectRed(swap(greenLines(), 'CTG_MANIFEST ', bare), bare)
  })

  it('carries committed=0 into the result for a manifest that is not the committed one', () => {
    const lines = swap(greenLines(), 'CTG_MANIFEST ', manifestLine(MANIFEST_SHA, 0))
    expect(judge(lines)).toMatchObject({ verdict: 'GREEN', committed: false })
  })

  it('prints the manifest identity in the GREEN verdict line', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'ctg-verdict-'))
    writeFileSync(join(dir, 'summary.txt'), `${greenLines().join('\n')}\n`)
    const manifest = fileURLToPath(new URL('../combined-tree-gate.jsonc', import.meta.url))
    const printed = []
    const log = console.log
    console.log = (line) => printed.push(line)
    // Act
    let rc
    try {
      rc = runCli(['verdict', '--manifest', manifest, '--summary', join(dir, 'summary.txt')])
    } finally {
      console.log = log
    }
    // Assert
    expect(rc).toBe(0)
    expect(printed).toEqual([`TIP_VERDICT GREEN head=${SHA} manifest=${MANIFEST_SHA} committed=1`])
  })
})

// Real shapes from the P1 tip logs: the list reporter colours the counts line.
const COLOURED_SPEC_LOG = [
  '[e2e-cleanup] orca-app {"state":"CLEANUP_SUCCEEDED","elapsedMs":2043,"attempts":1}',
  '  \u001b[32m✓\u001b[39m  \u001b[2m2 \u001b[22m[electron-headless] › tests/e2e/mission-brief.spec.ts:219:7 › renders',
  '',
  '\u001b[32m  2 passed\u001b[39m\u001b[2m (1.9m)\u001b[22m',
  ''
].join('\n')
const VITEST_LOG = [
  ' ✓ src/main/ipc/pty-pane-claim-arbitration.test.ts (6 tests) 8078ms',
  '',
  '\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[32m67 passed\u001b[39m\u001b[22m\u001b[90m (67)\u001b[39m',
  '\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m623 passed\u001b[39m\u001b[22m | 6 skipped (629)',
  '   Start at  20:46:34',
  ''
].join('\n')
const vitestJson = (files) =>
  JSON.stringify({
    numTotalTests: 3,
    testResults: files.map(([name, status, assertions]) => ({
      name,
      status,
      assertionResults: assertions.map(([fullName, s]) => ({ fullName, status: s }))
    }))
  })

describe('mintSpecResult', () => {
  it('reads a coloured counts line once ANSI is stripped', () => {
    const line = mintSpecResult({ name: 'mission-brief', exit: '0', log: COLOURED_SPEC_LOG })
    expect(line).toBe(
      'SPEC_RESULT mission-brief label=real exit=0 verdict=PRODUCT_RUN  2 passed (1.9m);'
    )
  })

  it('joins every counts line in P1 grammar', () => {
    const log =
      '  1 failed\n    [electron-headless] › tests/e2e/x.spec.ts:3:1 › t\n  1 skipped\n  2 passed (1.0m)\n'
    const line = mintSpecResult({ name: 'x', exit: '1', log })
    expect(line).toBe(
      'SPEC_RESULT x label=real exit=1 verdict=PRODUCT_RUN  1 failed; 1 skipped; 2 passed (1.0m);'
    )
  })

  it('reads "No tests found" as HARNESS_FAILED', () => {
    const line = mintSpecResult({ name: 'x', exit: '1', log: 'Error: No tests found.\n' })
    expect(line).toBe('SPEC_RESULT x label=real exit=1 verdict=HARNESS_FAILED ')
  })

  it('reads a log with no counts line, or no log at all, as NO_RESULT', () => {
    expect(mintSpecResult({ name: 'x', exit: '124', log: 'Terminated\n' })).toBe(
      'SPEC_RESULT x label=real exit=124 verdict=NO_RESULT '
    )
    expect(mintSpecResult({ name: 'x', exit: '0', log: null })).toBe(
      'SPEC_RESULT x label=real exit=0 verdict=NO_RESULT '
    )
  })

  it('reports a moved HEAD without reading a log', () => {
    const line = mintSpecResult({ name: 'x', exit: '0', log: null, headMoved: '05b57a67c' })
    expect(line).toBe('SPEC_RESULT x label=real exit=99 verdict=HEAD_MOVED from=05b57a67c')
  })
})

describe('mintUnitResult and unitRegressions', () => {
  it('prints the vitest counts in P1 grammar', () => {
    const line = mintUnitResult({ group: 'pty', exit: '0', log: VITEST_LOG })
    expect(line).toBe(
      'UNIT pty exit=0  Test Files 67 passed (67); Tests 623 passed | 6 skipped (629);'
    )
  })

  it('counts failed assertions and failed files, minus known failures keyed by file and name', () => {
    const json = vitestJson([
      [
        '/t/a.test.ts',
        'failed',
        [
          ['a fails', 'failed'],
          ['a known', 'failed'],
          ['a ok', 'passed']
        ]
      ],
      ['/t/b.test.ts', 'failed', []],
      ['/t/c.test.ts', 'passed', [['c ok', 'passed']]]
    ])
    const result = unitRegressions('pty', json, ['a.test.ts::a known'], { root: '/t' })
    expect(result.line).toBe('UNIT_PTY_REGRESSIONS 2')
    expect(result.failuresText).toBe(
      'a.test.ts::a fails\na.test.ts::a known\nb.test.ts::FILE_FAILED\n'
    )
  })

  it('counts a file whose hook failed although every assertion in it passed (WR-10)', () => {
    const json = vitestJson([['/t/a.test.ts', 'failed', [['a ok', 'passed']]]])
    const result = unitRegressions('pty', json, [], { root: '/t' })
    expect(result.line).toBe('UNIT_PTY_REGRESSIONS 1')
    expect(result.failuresText).toBe('a.test.ts::FILE_FAILED\n')
  })

  it('does not let a known failure in one file excuse the same name failing in another (WR-10)', () => {
    const json = vitestJson([
      ['/t/a.test.ts', 'failed', [['shared name', 'failed']]],
      ['/t/b.test.ts', 'failed', [['shared name', 'failed']]]
    ])
    const result = unitRegressions('pty', json, ['a.test.ts::shared name'], { root: '/t' })
    expect(result.line).toBe('UNIT_PTY_REGRESSIONS 1')
  })

  it('counts unhandled errors and an unattributed failed run as regressions no baseline excuses (WR-10)', () => {
    const clean = vitestJson([['/t/a.test.ts', 'passed', [['a ok', 'passed']]]])
    expect(unitRegressions('pty', clean, [], { root: '/t', unhandled: true }).line).toBe(
      'UNIT_PTY_REGRESSIONS 1'
    )
    const failedRun = JSON.stringify({ success: false, testResults: [] })
    const result = unitRegressions('pty', failedRun, [
      'UNHANDLED_ERRORS',
      'RUN_FAILED_WITHOUT_ATTRIBUTION'
    ])
    expect(result.line).toBe('UNIT_PTY_REGRESSIONS 1')
  })

  it('writes NONE when nothing failed', () => {
    const result = unitRegressions(
      'pty',
      vitestJson([['/t/c.test.ts', 'passed', [['c ok', 'passed']]]]),
      []
    )
    expect(result).toEqual({ line: 'UNIT_PTY_REGRESSIONS 0', failuresText: 'NONE\n' })
  })

  it('reads unreadable JSON as unknown, never as 0', () => {
    expect(unitRegressions('pty', null, []).line).toMatch(/^UNIT_PTY_REGRESSIONS unknown /)
    expect(unitRegressions('pty', '{"testResults":', []).line).toMatch(
      /^UNIT_PTY_REGRESSIONS unknown /
    )
    expect(unitRegressions('pty', '{}', []).line).toMatch(/^UNIT_PTY_REGRESSIONS unknown /)
  })
})

describe('mintGateResult', () => {
  it('prints the last non-empty log line, ANSI-stripped and capped at 160 characters', () => {
    const log = `checking\n\u001b[32m${'x'.repeat(200)}\u001b[39m\n\n`
    expect(mintGateResult({ name: 'oxfmt', exit: '1', log })).toBe(
      `GATE oxfmt exit=1 ${'x'.repeat(160)}`
    )
  })

  it('records a changed-files gate with no changed files as passing without a run', () => {
    expect(mintGateResult({ name: 'oxlint', exit: '', log: null, noChangedFiles: true })).toBe(
      'GATE oxlint exit=0 no changed files'
    )
  })

  it('records a changed-files gate whose file list could not be computed as not passing', () => {
    const line = mintGateResult({ name: 'oxlint', exit: '', log: null, changedFilesUnknown: true })
    expect(line).toBe('GATE oxlint exit=unknown changed files could not be computed')
  })

  it('never reads an unreadable gate log as a pass', () => {
    const line = mintGateResult({ name: 'tsc-node', exit: '0', log: null })
    expect(line.split(' ')[2]).not.toBe('exit=0')
  })
})

describe('minted lines round-trip through the verdict', () => {
  const header = [
    `HEAD=${SHA} dirty=0`,
    'LOCK_OK 0e3e7a3189836879',
    manifestLine(),
    `BUILD_real_EXIT=0 head=${SHA.slice(0, 9)} dirty=0`,
    ...treePhases(MANIFEST).map((phase) => treeAt(phase))
  ]
  const passLog = (n) => `\u001b[32m  ${n} passed\u001b[39m\u001b[2m (1.0m)\u001b[22m\n`
  const unitLog = (n) =>
    `\u001b[2m Test Files \u001b[22m ${n} passed (${n})\n      Tests  9 passed (9)\n`
  const json = vitestJson([['/t/a.test.ts', 'passed', [['ok', 'passed']]]])

  function minted({ skipMissionBrief = false } = {}) {
    return [
      ...header,
      ...MANIFEST.specs.map((s) =>
        mintSpecResult({
          name: s.name,
          exit: '0',
          log:
            skipMissionBrief && s.name === 'mission-brief' ? '  2 skipped\n' : passLog(s.minPassed)
        })
      ),
      ...MANIFEST.unitGroups.flatMap((g) => [
        mintUnitResult({ group: g.name, exit: '0', log: unitLog(g.minPassedFiles) }),
        ...(g.regressionDiff ? [unitRegressions(g.name, json, g.knownFailures).line] : [])
      ]),
      ...MANIFEST.staticGates.map((g) => mintGateResult({ name: g.name, exit: '0', log: 'done\n' }))
    ]
  }

  it('reads a fully minted passing run as GREEN', () => {
    expect(judge(minted())).toMatchObject({ verdict: 'GREEN', head: SHA, failures: [] })
  })

  it('reads a minted all-skipped spec as RED below its floor', () => {
    expectRed(minted({ skipMissionBrief: true }), 'FLOOR SPEC_RESULT mission-brief passed=0 min=2')
  })
})

describe('mint CLI', () => {
  it('writes the failure list and prints both unit lines', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'ctg-'))
    writeFileSync(join(dir, 'unit.log'), VITEST_LOG)
    writeFileSync(
      join(dir, 'unit.json'),
      vitestJson([['/t/c.test.ts', 'passed', [['c ok', 'passed']]]])
    )
    const manifest = fileURLToPath(new URL('../combined-tree-gate.jsonc', import.meta.url))
    const printed = []
    const log = console.log
    console.log = (line) => printed.push(line)
    // Act
    let rc
    try {
      rc = runCli([
        'unit-result',
        '--manifest',
        manifest,
        '--group',
        'pty',
        '--exit',
        '0',
        '--log',
        join(dir, 'unit.log'),
        '--json',
        join(dir, 'unit.json'),
        '--failures-out',
        join(dir, 'failures.txt')
      ])
    } finally {
      console.log = log
    }
    // Assert
    expect(rc).toBe(0)
    expect(printed).toEqual([
      'UNIT pty exit=0  Test Files 67 passed (67); Tests 623 passed | 6 skipped (629);',
      'UNIT_PTY_REGRESSIONS 0'
    ])
    expect(readFileSync(join(dir, 'failures.txt'), 'utf8')).toBe('NONE\n')
  })
})

describe('unit-result CLI unhandled errors (WR-10)', () => {
  it('counts a vitest "Unhandled Errors" block as a regression although the JSON shows none', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'ctg-unhandled-'))
    writeFileSync(join(dir, 'unit.log'), `${VITEST_LOG}\n Unhandled Errors \n`)
    writeFileSync(
      join(dir, 'unit.json'),
      vitestJson([['/t/c.test.ts', 'passed', [['c ok', 'passed']]]])
    )
    const manifest = fileURLToPath(new URL('../combined-tree-gate.jsonc', import.meta.url))
    const printed = []
    const log = console.log
    console.log = (line) => printed.push(line)
    // Act
    try {
      runCli([
        'unit-result',
        '--manifest',
        manifest,
        '--group',
        'pty',
        '--exit',
        '1',
        '--log',
        join(dir, 'unit.log'),
        '--json',
        join(dir, 'unit.json'),
        '--failures-out',
        join(dir, 'failures.txt')
      ])
    } finally {
      console.log = log
    }
    // Assert
    expect(printed.at(-1)).toBe('UNIT_PTY_REGRESSIONS 1')
    expect(readFileSync(join(dir, 'failures.txt'), 'utf8')).toBe('UNHANDLED_ERRORS\n')
  })
})
