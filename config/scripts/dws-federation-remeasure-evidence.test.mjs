import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  REALITY_FILES,
  buildEvidence,
  judgeRemeasure,
  parseGateSummary,
  renderEvidenceMarkdown,
  scanForSecrets,
  validateEvidence
} from './dws-federation-remeasure-evidence.mjs'

const HEAD = 'a'.repeat(40)
const ATTR = '71dd7bc97' + 'b'.repeat(31)
const ORCA_X = 'c'.repeat(40)
const WRITER = fileURLToPath(new URL('./dws-federation-remeasure-evidence-write.mjs', import.meta.url))

function summary(sha, o = {}) {
  const {
    label = 'head',
    rev = sha,
    node = 'v24.1.0',
    disk = 31,
    dbRc = 0,
    migRc = 0,
    tscRc = 0,
    tscErrors = 0,
    files = 95,
    reality = 'unset',
    vitestRc = 0,
    failed = 0,
    tree = 1,
    done = true,
    extra = []
  } = o
  return [
    `P7_BEGIN label=${label} sha=${sha}`,
    `REV_BEFORE_GATES ${rev}`,
    `NODE_VERSION ${node}`,
    `DISK_FREE_GB_BEFORE ${disk}`,
    `GATE db-probe rc=${dbRc}`,
    `GATE migration rc=${migRc}`,
    `GATE tsc-node rc=${tscRc}`,
    `TSC_ERRORS ${tscErrors}`,
    `VITEST_FILES ${files}`,
    `ORCA_CLAUDE_REALITY ${reality}`,
    `GATE vitest rc=${vitestRc}`,
    `VITEST total=900 passed=${897 - failed} failed=${failed} skipped=3 suites=${files} skippedFiles=3`,
    `TREE_CLEAN=${tree}`,
    `DISK_FREE_GB_AFTER ${disk}`,
    ...extra,
    ...(done ? ['P7_DONE'] : [])
  ].join('\n')
}

function fence(sha, label, o = {}) {
  return {
    sha,
    label,
    localHead: HEAD,
    remoteRevParse: o.remote ?? sha,
    fenceOk: `FENCE_OK ${HEAD}`,
    orcaXHeadBefore: ORCA_X,
    orcaXHeadAfter: ORCA_X,
    summaryText: o.text ?? summary(sha, { label, ...(o.summary ?? {}) }),
    failedTests: o.failedTests ?? [],
    tscErrors: o.tscErrors ?? [],
    skippedFiles: o.skippedFiles ?? [...REALITY_FILES, 'other.test.ts'],
    treeClean: true,
    utcStart: '2026-09-30T10:00:00Z',
    utcEnd: '2026-09-30T10:20:00Z',
    blocked: null
  }
}

function record(overrides = {}) {
  return {
    headSha: HEAD,
    federationHead: ATTR,
    serveDeployedSha: '3266e1a' + 'd'.repeat(33),
    containment: { fetch: { outcome: 'ok' }, behind: 0 },
    fences: { attribution: fence(ATTR, 'attribution'), head: fence(HEAD, 'head') },
    ownership: { exit: 0, stdout: 'OWNERSHIP owned=97 verdict=OK' },
    cloneHeadAtEnd: HEAD,
    orcaXHeadAtEnd: ORCA_X,
    cloneLeftAtGatedSha: true,
    timeouts: [],
    ...overrides
  }
}

function judge(rec) {
  return judgeRemeasure({
    headFence: rec.fences.head,
    attributionFence: rec.fences.attribution,
    localHead: rec.headSha,
    containment: rec.containment,
    timeouts: rec.timeouts
  })
}

describe('parseGateSummary', () => {
  it('Test 1: parses the grammar, BLOCKED lines and a missing P7_DONE', () => {
    const parsed = parseGateSummary(summary(HEAD))
    expect(parsed).toMatchObject({
      label: 'head',
      sha: HEAD,
      revBeforeGates: HEAD,
      nodeVersion: 'v24.1.0',
      diskFreeGbBefore: 31,
      gates: { 'db-probe': 0, migration: 0, 'tsc-node': 0, vitest: 0 },
      tscErrorCount: 0,
      vitestFiles: 95,
      realityEnv: 'unset',
      treeClean: true,
      done: true,
      incomplete: false,
      blocked: null
    })
    expect(parsed.vitest).toEqual({ total: 900, passed: 897, failed: 0, skipped: 3, suites: 95, skippedFiles: 3 })
    expect(parseGateSummary(`P7_BEGIN label=head sha=${HEAD}\nBLOCKED disk-floor 3 GiB free\nP7_DONE`).blocked).toEqual({
      rung: 'disk-floor',
      reason: '3 GiB free'
    })
    expect(parseGateSummary(summary(HEAD, { done: false })).incomplete).toBe(true)
  })
})

describe('judgeRemeasure', () => {
  it('Test 2: both fences green is MEASURED with no red', () => {
    expect(judge(record())).toMatchObject({ verdict: 'MEASURED', rungReached: 'gates', preExistingRed: [], headOnlyRed: [] })
  })

  it('Test 3: head red identical to attribution red is MEASURED with preExistingRed named', () => {
    const red = { failedTests: ['suite > breaks'], tscErrors: ['src/a.ts(1,1): error TS2322: x'], summary: { failed: 1, vitestRc: 1, tscRc: 2, tscErrors: 1 } }
    const rec = record({ fences: { attribution: fence(ATTR, 'attribution', red), head: fence(HEAD, 'head', red) } })
    const verdict = judge(rec)
    expect(verdict.verdict).toBe('MEASURED')
    expect(verdict.preExistingRed).toEqual(['tsc: src/a.ts(1,1): error TS2322: x', 'vitest: suite > breaks'])
    expect(verdict.headOnlyRed).toEqual([])
  })

  it('Test 4: a red only at head is FAIL naming exactly that item (test, tsc line, migration rc)', () => {
    const base = { failedTests: ['suite > breaks'], summary: { failed: 1, vitestRc: 1 } }
    const headRed = { failedTests: ['suite > breaks', 'suite > new break'], summary: { failed: 2, vitestRc: 1 } }
    const rec = record({ fences: { attribution: fence(ATTR, 'attribution', base), head: fence(HEAD, 'head', headRed) } })
    expect(judge(rec)).toMatchObject({ verdict: 'FAIL', headOnlyRed: ['vitest: suite > new break'] })
    const tsc = record({ fences: { attribution: fence(ATTR, 'attribution'), head: fence(HEAD, 'head', { tscErrors: ['x error TS1'], summary: { tscRc: 2, tscErrors: 1 } }) } })
    expect(judge(tsc)).toMatchObject({ verdict: 'FAIL', headOnlyRed: ['tsc: x error TS1'] })
    const mig = record({ fences: { attribution: fence(ATTR, 'attribution'), head: fence(HEAD, 'head', { summary: { migRc: 1 } }) } })
    expect(judge(mig)).toMatchObject({ verdict: 'FAIL', headOnlyRed: ['gate: migration'] })
  })

  const headWith = (o) => record({ fences: { attribution: fence(ATTR, 'attribution'), head: fence(HEAD, 'head', o) } })
  const cases = [
    ['fetch', record({ containment: { fetch: { outcome: 'failed' } } })],
    ['ssh', record({ timeouts: ['scp-bundle'] })],
    ['attribution-fence', record({ fences: { head: fence(HEAD, 'head') } })],
    ['fence-mismatch', headWith({ remote: 'e'.repeat(40) })],
    ['tree-dirty', headWith({ summary: { tree: 0 } })],
    ['disk-floor', headWith({ summary: { disk: 4 } })],
    ['disk-floor', headWith({ text: `P7_BEGIN label=head sha=${HEAD}\nBLOCKED disk-floor low\nP7_DONE` })],
    ['file-list-below-floor', headWith({ summary: { files: 89 } })],
    ['db-probe', headWith({ summary: { dbRc: 1 } })],
    ['gates-timeout', headWith({ summary: { done: false } })],
    ['toolchain', headWith({ summary: { node: 'v18.19.0' } })],
    ['reality-legs-not-skipped', headWith({ skippedFiles: ['review-reality.test.ts'] })],
    ['reality-legs-not-skipped', headWith({ summary: { reality: 'set' } })]
  ]
  it.each(cases)('Test 5: %s is BLOCKED and never MEASURED/FAIL', (rung, rec) => {
    const verdict = judge(rec)
    expect(verdict.verdict).toBe('BLOCKED')
    expect(verdict.rungReached).toBe(rung)
  })

  it('Test 5: a failed fetch outranks every fence problem', () => {
    const rec = record({ containment: { fetch: { outcome: 'failed' } }, fences: {} })
    expect(judge(rec).rungReached).toBe('fetch')
  })

  it('Test 6: skipped is not passed and the reality files are required among the skipped', () => {
    const ev = buildEvidence(record())
    expect(ev.fences.head.vitest.passed).toBe(897)
    expect(ev.fences.head.vitest.passed + ev.fences.head.vitest.skipped + ev.fences.head.vitest.failed).toBe(ev.fences.head.vitest.total)
    for (const file of REALITY_FILES) {
      expect(ev.fences.head.skippedFiles).toContain(file)
    }
  })
})

describe('secret refusal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p7-evidence-'))
  // Why: a literal key header in this file would trip the repository's own secret firewall.
  const shapes = {
    'pairing-url': 'orca://pair?x=1',
    'code-query': 'https://h/p?code=abc',
    'agent-home': '/home/kobii/.claude/x',
    'github-token': `ghp_${'A'.repeat(36)}`,
    'private-key': ['-----BEGIN ', 'OPENSSH PRIVATE', ' KEY-----'].join('')
  }
  it.each(Object.entries(shapes))('Test 7: %s makes the writer refuse and name the class only', (klass, text) => {
    expect(scanForSecrets(text)).toContain(klass)
    const rec = record({ notes: text })
    const recPath = join(dir, `rec-${klass}.json`)
    writeFileSync(recPath, JSON.stringify(rec))
    const out = join(dir, `out-${klass}`)
    const run = spawnSync(process.execPath, [WRITER, '--record', recPath, '--out-json', `${out}.json`, '--out-md', `${out}.md`], { encoding: 'utf8' })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(klass)
    expect(run.stderr).not.toContain(text)
  })
})

describe('validateEvidence', () => {
  it('Test 8: refuses PASS, a bad sha, a missing fence, a BLOCKED without rung, missing closing heads', () => {
    const good = buildEvidence(record())
    expect(validateEvidence(good).ok).toBe(true)
    expect(validateEvidence({ ...good, verdict: 'PASS' }).ok).toBe(false)
    expect(validateEvidence({ ...good, headSha: 'abc' }).ok).toBe(false)
    expect(validateEvidence({ ...good, fences: { attribution: good.fences.attribution, head: null } }).ok).toBe(false)
    expect(validateEvidence({ ...good, verdict: 'BLOCKED', rungReached: null, blockedReason: null }).ok).toBe(false)
    expect(validateEvidence({ ...good, cloneHeadAtEnd: null }).ok).toBe(false)
    expect(validateEvidence({ ...good, orcaXHeadAtEnd: null }).ok).toBe(false)
    const preflight = buildEvidence(record({ blocked: { rung: 'preflight', reason: 'ssh unreachable' }, cloneHeadAtEnd: null, orcaXHeadAtEnd: null }))
    expect(validateEvidence(preflight).ok).toBe(true)
  })

  it('Test 8: a head-fence BLOCKED evidence needs a cloneLeftNote naming 71dd7bc97', () => {
    const base = { fences: { attribution: fence(ATTR, 'attribution'), head: fence(HEAD, 'head', { summary: { done: false } }) }, cloneHeadAtEnd: ATTR, cloneLeftAtGatedSha: false }
    expect(validateEvidence(buildEvidence(record(base))).ok).toBe(false)
    const noted = record({ ...base, cloneLeftNote: 'the build clone was left at 71dd7bc97 (the attribution fence); the head fence was BLOCKED at gates-timeout' })
    expect(validateEvidence(buildEvidence(noted)).ok).toBe(true)
  })
})

describe('renderEvidenceMarkdown', () => {
  it('Test 9: carries verdict, both shas, not-rerun list, correction, ND-1 and the two-sha distinction', () => {
    const ev = buildEvidence(record())
    const md = renderEvidenceMarkdown(ev)
    for (const needle of [
      'Verdict: MEASURED',
      HEAD,
      ATTR,
      'mutation drills',
      'agent-federation-approval.spec.ts',
      '2e8c5516a',
      'not present in the object store',
      'da3ec43c0',
      '47558af87',
      'ND-1',
      'gatesFencedSha',
      'serveDeployedSha'
    ]) {
      expect(md).toContain(needle)
    }
  })
})

const REMOTE_SCRIPT = fileURLToPath(new URL('./dws-federation-gates-remote.sh', import.meta.url))
// Why: the header comment says the script never builds or installs, so a naive word grep would refuse it.
const codeLines = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line))
const SUMMARY_SHAPES = [
  'P7_BEGIN',
  'REV_BEFORE_GATES',
  'NODE_VERSION',
  'DISK_FREE_GB_BEFORE',
  'GATE db-probe rc=',
  'GATE migration rc=',
  'GATE tsc-node rc=',
  'TSC_ERRORS',
  'VITEST_FILES',
  'ORCA_CLAUDE_REALITY unset',
  'GATE vitest rc=',
  'VITEST total=',
  'TREE_CLEAN=',
  'DISK_FREE_GB_AFTER',
  'P7_DONE',
  'BLOCKED %s'
]
const FORBIDDEN_SHAPES = [
  [/(^|[\s;&|])rm\s/, 'rm'],
  [/\$\{[^}]*[%#]/, 'parameter expansion with % or #'],
  [/\bpnpm\b/, 'pnpm'],
  [/\bsudo\b/, 'sudo'],
  [/provision\.sh\s+(build|install)\b/, 'provision build/install'],
  [/fed-wt|orca-env/, 'other program tree'],
  [/\bgit\s+(clean|reset|stash|fetch|pull|push)\b/, 'forbidden git mutation']
]
const forbiddenIn = (text) =>
  FORBIDDEN_SHAPES.filter(([re]) => re.test(codeLines(text).join('\n'))).map(([, name]) => name)

describe('remote gate script contract', () => {
  const text = readFileSync(REMOTE_SCRIPT, 'utf8')

  it('Test 11: prints every summary line shape the parser reads, P7_BEGIN first', () => {
    const code = codeLines(text).join('\n')
    for (const shape of SUMMARY_SHAPES) {
      expect(code, shape).toContain(shape)
    }
    const firstOutput = codeLines(text).find((line) => /\b(printf|echo)\b/.test(line) && !line.includes('>&2'))
    expect(firstOutput).toContain('P7_BEGIN')
    expect(text).not.toContain('\r')
  })

  it('Test 11: dropping one summary line from a scratch copy is detected', () => {
    const scratch = text.replace("printf 'TREE_CLEAN=0\\n'", ':')
    expect(scratch).not.toBe(text)
    expect(codeLines(scratch).join('\n')).not.toContain('TREE_CLEAN=0')
  })

  it('Test 12: no forbidden shape outside comments, with a control that the check can fire', () => {
    expect(forbiddenIn(text)).toEqual([])
    expect(forbiddenIn(`${text}\nbash provision.sh build abc\n`)).toContain('provision build/install')
    expect(forbiddenIn(`${text}\nrm -f x\n`)).toContain('rm')
    expect(forbiddenIn(`${text}\necho \${X%%a*}\n`)).toContain('parameter expansion with % or #')
  })

  it('Test 12: the only write targets are under the run directory argument', () => {
    // Why: the inline node summariser and the usage echo carry `>` inside strings, which are not redirections.
    const shell = codeLines(text.replace(/node -e '[\s\S]*?\n' "\$RUN_DIR"/, ''))
      .map((line) => line.replace(/'[^']*'|"[^"]*"/g, (quoted) => (/\s/.test(quoted) ? '' : quoted)))
    const redirects = shell.flatMap((line) =>
      [...line.matchAll(/(?<!&)>>?(?!&)\s*("?[^\s"&|;]+"?)/g)].map((m) => m[1])
    )
    expect(redirects.length).toBeGreaterThan(5)
    for (const target of redirects) {
      expect(target.replace(/"/g, ''), target).toMatch(/^(\$RUN_DIR\/|\/dev\/null$)/)
    }
  })

  it('Test 13: names the 12 federation files outside the two directories and no daemon test', () => {
    const named = [
      'src/cli/index-orchestration.test.ts',
      'src/main/claude/claude-auth-readiness.test.ts',
      'src/main/claude/claude-conversation-driver.test.ts',
      'src/main/claude/claude-conversation-reality.test.ts',
      'src/main/claude/claude-mcp-bridge-reality.test.ts',
      'src/main/codex/codex-conversation-driver-tools.test.ts',
      'src/main/codex/codex-server-request-bridge-tools.test.ts',
      'src/main/ipc/agent-federation.test.ts',
      'src/main/ipc/conversations.test.ts',
      'src/main/runtime/rpc/methods/orchestration-reviews.test.ts',
      'src/main/runtime/rpc/methods/orchestration-runs.test.ts',
      'src/main/runtime/rpc/methods/orchestration-task-delegation.test.ts'
    ]
    for (const file of named) {
      expect(text).toContain(file)
    }
    expect(codeLines(text).join('\n').toLowerCase()).not.toContain('daemon')
  })
})

describe('writer glue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p7-writer-'))
  function write(rec, name, bom) {
    const path = join(dir, name)
    writeFileSync(path, `${bom ? '\uFEFF' : ''}${JSON.stringify(rec)}`)
    return path
  }
  function run(recPath, tag) {
    const outJson = join(dir, `${tag}.json`)
    const outMd = join(dir, `${tag}.md`)
    const result = spawnSync(process.execPath, [WRITER, '--record', recPath, '--out-json', outJson, '--out-md', outMd], { encoding: 'utf8' })
    return { result, outJson, outMd }
  }

  it('Test 10a: a record beginning with a byte-order mark is read without a parse error', () => {
    const { result, outJson } = run(write(record(), 'bom.json', true), 'bom')
    expect(result.status).toBe(0)
    expect(JSON.parse(readFileSync(outJson, 'utf8')).verdict).toBe('MEASURED')
  })

  it('Test 10: a head-only failed test is carried through the writer as FAIL (positive control)', () => {
    const headRed = { failedTests: ['suite > new break'], summary: { failed: 1, vitestRc: 1 } }
    const rec = record({ fences: { attribution: fence(ATTR, 'attribution'), head: fence(HEAD, 'head', headRed) } })
    const { result, outJson } = run(write(rec, 'red.json', false), 'red')
    expect(result.status).toBe(0)
    const written = JSON.parse(readFileSync(outJson, 'utf8'))
    expect(written.verdict).toBe('FAIL')
    expect(written.attribution.headOnlyRed).toEqual(['vitest: suite > new break'])
    const validated = spawnSync(process.execPath, [WRITER, '--validate', outJson], { encoding: 'utf8' })
    expect(validated.status).toBe(0)
  })
})
