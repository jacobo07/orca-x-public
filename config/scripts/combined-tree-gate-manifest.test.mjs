import { readFileSync } from 'node:fs'
import { parse } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'
import { loadManifest, planLines } from './combined-tree-gate-manifest.mjs'

const RAW = readFileSync(new URL('../combined-tree-gate.jsonc', import.meta.url), 'utf8')
const MANIFEST = loadManifest(RAW)

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
    expect(lines.at(-1)).toBe('PLAN_COUNTS specs=15 units=3 gates=9')
    expect(lines).toContain('PLAN_GATE oxfmt 1 node_modules/.bin/oxfmt --check')
    expect(lines).toContain('PLAN_UNIT pty 70 1 src/main/ipc/pty')
  })
})

describe('loadManifest: reserved environment names (WR-02)', () => {
  const edited = (edit) => {
    const m = parse(RAW)
    edit(m)
    return JSON.stringify(m)
  }
  const RESERVED = [
    'PATH',
    'NODE_OPTIONS',
    'LD_PRELOAD',
    'CTG_RUN_ID',
    'CTG_RUNS_DIR',
    'SKIP_BUILD',
    'MANIFEST',
    'CONTRACT',
    'TREE',
    'BASE',
    'HEAD',
    'RUN',
    'S',
    'SELF',
    'ARGS',
    'RUN_ID',
    'DIRT_EXCLUDE',
    'REAP_MECHANISM',
    'SPEC_PID',
    // bash's own variables (IN-24)
    'RANDOM',
    'SECONDS',
    'LINENO',
    'PPID',
    'UID',
    'EUID',
    'HOSTNAME',
    'HOSTTYPE',
    'OSTYPE',
    'MACHTYPE',
    'SHLVL',
    'GROUPS',
    'PIPESTATUS',
    'FUNCNAME',
    'EPOCHSECONDS',
    'SRANDOM',
    'IFS',
    'PS1',
    'PS4',
    'SHELLOPTS',
    'BASHOPTS',
    'PROMPT_COMMAND'
  ]

  it.each(RESERVED)('refuses %s in specEnv', (name) => {
    const raw = edited((m) => (m.specEnv[name] = 'x'))
    expect(() => loadManifest(raw)).toThrow(new RegExp(`specEnv name ${name} is reserved`))
  })

  it.each(RESERVED)('refuses %s in requiredEnv', (name) => {
    const raw = edited((m) => m.requiredEnv.push({ name }))
    expect(() => loadManifest(raw)).toThrow(new RegExp(`requiredEnv ${name} is reserved`))
  })

  it('still accepts the committed, non-reserved names (control)', () => {
    expect(Object.keys(MANIFEST.specEnv)).toEqual(['MISSION_BRIEF_VISUAL'])
    expect(MANIFEST.requiredEnv.map((e) => e.name)).toEqual(['MISSION_BRIEF_REPOS'])
  })
})

describe('loadManifest: knownFailures never baseline a suite error (WR-23)', () => {
  const withKnown = (entry) => {
    const m = parse(RAW)
    const group = m.unitGroups.find((g) => g.regressionDiff)
    group.knownFailures = [entry]
    return JSON.stringify(m)
  }

  it('refuses a ::FILE_FAILED entry', () => {
    expect(() => loadManifest(withKnown('a.test.ts::FILE_FAILED'))).toThrow(/FILE_FAILED/)
  })

  it('still accepts a named test (control)', () => {
    expect(() => loadManifest(withKnown('a.test.ts::a known flake'))).not.toThrow()
  })
})
