import { describe, expect, it } from 'vitest'
import {
  FAMILY_PATTERNS,
  classifyRun,
  computeDelta,
  judgeAbsence,
  judgeBracket,
  parseSamples,
  redactCommandLine,
  subtreePids,
  summarizeLatencies,
  summarizeRun
} from './dws-offload-measurement.mjs'

// Why a synthetic estate rather than a real captured run: a drill pinned to real sampler bytes has
// an interest in that exact process shape staying unchanged, and decays the day the run is re-taken.
// These fixtures are clean by construction (instrument-before-claim.md / monetary-quantity-integrity.md
// "don't build a synthetic fixture out of real values").

function makeProc({ pid, ppid, name, commandLine = '', workingSetMb = 10, creationDate = '2026-09-28T00:00:00.000Z' }) {
  return { pid, ppid, name, commandLine, workingSetMb, creationDate }
}

function makeSample({ monoMs, freeMb, totalMb = 32000, procs, utc }) {
  return { kind: 'sample', utc: utc ?? `2026-09-28T00:00:${String(monoMs / 1000).padStart(2, '0')}.000Z`, monoMs, freeMb, totalMb, procs }
}

/**
 * Three-sample fixture exercising every classifyRun/summarizeRun outcome in one shared run:
 * desktop subtree (100 root, 101 renderer, 102 vitest worker), a pre-existing background claude.exe
 * (200), a harness root (600) and its mid-window child (500, no nonce), a mid-window nonce-carrying
 * dummy (300), and a nonce-carrying orca-cli dispatcher (400) that must stay control-plane.
 */
function buildThreeSampleFixture(nonce) {
  const desktop100 = { pid: 100, ppid: 1, name: 'electron.exe', commandLine: '"C:\\orca\\electron.exe" .' }
  const desktop101 = { pid: 101, ppid: 100, name: 'electron.exe', commandLine: 'electron.exe --type=renderer' }
  const claude200 = { pid: 200, ppid: 1, name: 'claude.exe', commandLine: 'claude.exe --resume', workingSetMb: 120 }
  const harness600 = { pid: 600, ppid: 1, name: 'node.exe', commandLine: 'node harness-hook.js', workingSetMb: 10 }

  const sample1 = makeSample({
    monoMs: 0,
    freeMb: 5000,
    procs: [
      makeProc({ ...desktop100, workingSetMb: 200 }),
      makeProc({ ...desktop101, workingSetMb: 150 }),
      makeProc({ pid: 102, ppid: 100, name: 'node.exe', commandLine: 'node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts x.test.mjs', workingSetMb: 300 }),
      makeProc(claude200),
      makeProc(harness600)
    ]
  })
  const sample2 = makeSample({
    monoMs: 1000,
    freeMb: 4990,
    procs: [
      makeProc({ ...desktop100, workingSetMb: 200 }),
      makeProc({ ...desktop101, workingSetMb: 150 }),
      makeProc({ pid: 102, ppid: 100, name: 'node.exe', commandLine: 'node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts x.test.mjs', workingSetMb: 320 }),
      makeProc(claude200),
      makeProc(harness600),
      makeProc({ pid: 300, ppid: 1, name: 'node.exe', commandLine: `node -e "setTimeout(()=>{},9000)" DWS-P2-SMOKE-${nonce}`, workingSetMb: 40 }),
      makeProc({ pid: 400, ppid: 1, name: 'node.exe', commandLine: `node out/cli/index.js terminal create --command DWS-P2-SMOKE-${nonce}`, workingSetMb: 25 })
    ]
  })
  const sample3 = makeSample({
    monoMs: 2000,
    freeMb: 4980,
    procs: [
      makeProc({ ...desktop100, workingSetMb: 200 }),
      makeProc({ ...desktop101, workingSetMb: 150 }),
      makeProc({ pid: 102, ppid: 100, name: 'node.exe', commandLine: 'node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts x.test.mjs', workingSetMb: 280 }),
      makeProc(claude200),
      makeProc(harness600),
      makeProc({ pid: 500, ppid: 600, name: 'node.exe', commandLine: 'node hook-child.js', workingSetMb: 15 })
    ]
  })
  return [sample1, sample2, sample3]
}

describe('parseSamples', () => {
  it('parses a first line prefixed with U+FEFF (PowerShell 5.1 BOM trap)', () => {
    const text =
      '\uFEFF' +
      JSON.stringify({ kind: 'sampler-start', samplerPid: 111, intervalMs: 1000, host: 'test-host', utc: '2026-09-28T00:00:00.000Z' }) +
      '\n' +
      JSON.stringify({ kind: 'sample', utc: '2026-09-28T00:00:00.000Z', monoMs: 0, freeMb: 5000, totalMb: 32000, procs: [] }) +
      '\n'
    const result = parseSamples(text)
    expect(result.unreadableLines).toBe(0)
    expect(result.samples).toHaveLength(1)
    expect(result.start).toMatchObject({ kind: 'sampler-start', samplerPid: 111 })
  })

  it('counts a malformed line in unreadableLines instead of silently dropping it', () => {
    const text = [
      JSON.stringify({ kind: 'sample', utc: 't1', monoMs: 0, freeMb: 5000, totalMb: 32000, procs: [] }),
      '{this is not valid json',
      JSON.stringify({ kind: 'sample', utc: 't2', monoMs: 1000, freeMb: 4990, totalMb: 32000, procs: [] })
    ].join('\n') + '\n'
    const result = parseSamples(text)
    expect(result.unreadableLines).toBe(1)
    expect(result.samples).toHaveLength(2)
  })

  it('redacts a pairing code inside a sample line defense-in-depth (the parser is part of the guard)', () => {
    const text =
      JSON.stringify({
        kind: 'sample',
        utc: 't1',
        monoMs: 0,
        freeMb: 1000,
        totalMb: 32000,
        procs: [{ pid: 1, ppid: 0, name: 'node.exe', commandLine: 'node x --pairing-code abc123', workingSetMb: 1 }]
      }) + '\n'
    const result = parseSamples(text)
    expect(result.samples[0].procs[0].commandLine).not.toContain('abc123')
    expect(result.samples[0].procs[0].commandLine).toContain('<redacted>')
  })
})

describe('redactCommandLine', () => {
  it('redacts orca://pair?code=... to <redacted>, removing the literal code', () => {
    const out = redactCommandLine('orca-cli.exe environment add orca://pair?code=abc --name gex44')
    expect(out).not.toContain('abc')
    expect(out).toContain('<redacted>')
  })

  it('redacts --pairing-code <code> to <redacted>', () => {
    const out = redactCommandLine('orca --pairing-code abc terminal create')
    expect(out).not.toContain('abc')
    expect(out).toContain('<redacted>')
  })

  it('redacts ORCA_PAIRING_CODE=<code> to <redacted>', () => {
    const out = redactCommandLine('cmd /c set ORCA_PAIRING_CODE=abc && orca terminal create')
    expect(out).not.toContain('abc')
    expect(out).toContain('<redacted>')
  })
})

describe('subtreePids', () => {
  it('returns rootPid plus all transitive descendants, excluding siblings', () => {
    const procs = [
      { pid: 1, ppid: 0 },
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 2 },
      { pid: 4, ppid: 0 }
    ]
    const result = subtreePids(procs, 1)
    expect(result).toEqual(new Set([1, 2, 3]))
  })
})

describe('classifyRun', () => {
  const nonce = 'NONCE-XYZ'

  it('classifies a node process running vitest.mjs inside the desktop subtree as workload:vitest', () => {
    const samples = buildThreeSampleFixture(nonce)
    const result = classifyRun(samples, { desktopRootPid: 100, nonce, harnessRootPids: [600] })
    const proc = result.processes.find((p) => p.pid === 102)
    expect(proc.classification).toBe('workload:vitest')
  })

  it('classifies electron.exe --type=renderer inside the subtree as control-surface', () => {
    const samples = buildThreeSampleFixture(nonce)
    const result = classifyRun(samples, { desktopRootPid: 100, nonce, harnessRootPids: [600] })
    const proc = result.processes.find((p) => p.pid === 101)
    expect(proc.classification).toBe('control-surface')
  })

  it('classifies the desktop root itself (unrecognized role) as control-surface, never accused', () => {
    const samples = buildThreeSampleFixture(nonce)
    const result = classifyRun(samples, { desktopRootPid: 100, nonce, harnessRootPids: [600] })
    const proc = result.processes.find((p) => p.pid === 100)
    expect(proc.classification).toBe('control-surface')
  })

  it('classifies a pre-existing claude.exe outside the subtree as background (never accused)', () => {
    const samples = buildThreeSampleFixture(nonce)
    const result = classifyRun(samples, { desktopRootPid: 100, nonce, harnessRootPids: [600] })
    const proc = result.processes.find((p) => p.pid === 200)
    expect(proc.classification).toBe('background')
  })

  it('classifies a node.exe created mid-window outside the subtree without the nonce as background', () => {
    const samples = buildThreeSampleFixture(nonce)
    const result = classifyRun(samples, { desktopRootPid: 100, nonce, harnessRootPids: [600] })
    const proc = result.processes.find((p) => p.pid === 500)
    expect(proc.classification).toBe('background')
  })

  it('classifies any process outside the subtree whose command line contains the nonce as workload:<family> (accused)', () => {
    const samples = buildThreeSampleFixture(nonce)
    const result = classifyRun(samples, { desktopRootPid: 100, nonce, harnessRootPids: [600] })
    const proc = result.processes.find((p) => p.pid === 300)
    expect(proc.classification).toMatch(/^workload:/)
  })

  it('classifies the orca-cli dispatcher as control-plane even when its command line carries the nonce (checked before the nonce rule)', () => {
    const samples = buildThreeSampleFixture(nonce)
    const result = classifyRun(samples, { desktopRootPid: 100, nonce, harnessRootPids: [600] })
    const proc = result.processes.find((p) => p.pid === 400)
    expect(proc.classification).toBe('control-plane')
  })

  it('classifies the orca-cli dispatcher as control-plane on a Windows-style backslash path too', () => {
    const samples = [
      makeSample({
        monoMs: 0,
        freeMb: 1000,
        procs: [makeProc({ pid: 700, ppid: 1, name: 'node.exe', commandLine: `node out\\cli\\index.js terminal create ${nonce}` })]
      })
    ]
    const result = classifyRun(samples, { desktopRootPid: 100, nonce, harnessRootPids: [] })
    const proc = result.processes.find((p) => p.pid === 700)
    expect(proc.classification).toBe('control-plane')
  })

  it('never accuses the executor claude.exe present before the run started (positive-control precondition)', () => {
    const samples = buildThreeSampleFixture(nonce)
    const result = classifyRun(samples, { desktopRootPid: 100, nonce, harnessRootPids: [600] })
    expect(result.processes.every((p) => p.pid !== 200 || p.classification === 'background')).toBe(true)
  })

  it('reports the desktop and harness subtree sizes actually resolved', () => {
    const samples = buildThreeSampleFixture(nonce)
    const result = classifyRun(samples, { desktopRootPid: 100, nonce, harnessRootPids: [600] })
    expect(result.desktopSubtreeSize).toBe(3)
    expect(result.harnessSubtreeSize).toBe(2)
  })
})

describe('summarizeRun', () => {
  it('computes per-family peak/median over present samples, workload total per sample, cadence, free-memory bracket, and the instrument label', () => {
    const nonce = 'NONCE-XYZ'
    const samples = buildThreeSampleFixture(nonce)
    const summary = summarizeRun(samples, { desktopRootPid: 100, nonce, harnessRootPids: [600], unreadableLines: 0 })

    expect(summary.perFamily.vitest.peakMb).toBe(320)
    expect(summary.perFamily.vitest.medianMb).toBe(300)
    expect(summary.perFamily.vitest.maxCount).toBe(1)

    expect(summary.perFamily['control-surface'].peakMb).toBe(350)
    expect(summary.perFamily['control-surface'].medianMb).toBe(350)
    expect(summary.perFamily['control-surface'].maxCount).toBe(2)

    expect(summary.perFamily.nonce.peakMb).toBe(40)
    expect(summary.perFamily.nonce.maxCount).toBe(1)

    expect(summary.workloadTotalPerSampleMb).toEqual([300, 360, 280])
    expect(summary.workloadTotal.peakMb).toBe(360)
    expect(summary.workloadTotal.medianMb).toBe(300)

    expect(summary.cadence.medianMs).toBe(1000)

    expect(summary.freeMb).toEqual({ before: 5000, after: 4980, min: 4980 })

    expect(summary.instrument).toBe('Win32_Process.WorkingSetSize via Get-CimInstance')
    expect(summary.unreadableLines).toBe(0)
    expect(summary.patterns).toBe(FAMILY_PATTERNS)
  })

  it('reports a family never seen this run with zero peak/median/count (no fabricated presence)', () => {
    const nonce = 'NONCE-XYZ'
    const samples = buildThreeSampleFixture(nonce)
    const summary = summarizeRun(samples, { desktopRootPid: 100, nonce, harnessRootPids: [600] })
    expect(summary.perFamily.codex).toEqual({ peakMb: 0, medianMb: 0, maxCount: 0, samplesPresent: 0, observed: [] })
  })
})

describe('judgeAbsence', () => {
  it('is PASS when the baseline saw the family (positive control) and the offload saw none', () => {
    const baseline = { perFamily: { codex: { maxCount: 1, observed: [{ pid: 10, commandLine: 'codex.exe' }] } } }
    const offload = { perFamily: { codex: { maxCount: 0, observed: [] } } }
    const verdict = judgeAbsence(baseline, offload, 'codex')
    expect(verdict.verdict).toBe('PASS')
  })

  it('is UNJUDGED with reason "no positive control" when the baseline never saw the family', () => {
    const baseline = { perFamily: { esbuild: { maxCount: 0, observed: [] } } }
    const offload = { perFamily: { esbuild: { maxCount: 0, observed: [] } } }
    const verdict = judgeAbsence(baseline, offload, 'esbuild')
    expect(verdict.verdict).toBe('UNJUDGED')
    expect(verdict.reason).toBe('no positive control')
  })

  it('is FAIL listing pid and redacted command when the offload still shows the family', () => {
    const baseline = { perFamily: { tsc: { maxCount: 1, observed: [{ pid: 11, commandLine: 'node typescript/bin/tsc' }] } } }
    const offload = { perFamily: { tsc: { maxCount: 1, observed: [{ pid: 999, commandLine: 'node typescript/bin/tsc --build' }] } } }
    const verdict = judgeAbsence(baseline, offload, 'tsc')
    expect(verdict.verdict).toBe('FAIL')
    expect(verdict.reason).toContain('999')
    expect(verdict.reason).toContain('typescript/bin/tsc')
  })
})

describe('computeDelta', () => {
  it('computes per-family and total delta (baseline minus offload), reporting control-surface separately and excluding it from the workload total', () => {
    const baseline = {
      perFamily: {
        vitest: { peakMb: 320, medianMb: 300 },
        'control-surface': { peakMb: 350, medianMb: 350 }
      },
      workloadTotal: { peakMb: 360, medianMb: 300 }
    }
    const offload = {
      perFamily: {
        vitest: { peakMb: 0, medianMb: 0 },
        'control-surface': { peakMb: 350, medianMb: 350 }
      },
      workloadTotal: { peakMb: 0, medianMb: 0 }
    }
    const delta = computeDelta(baseline, offload)
    expect(delta.perFamily.vitest).toEqual({ peakDeltaMb: 320, medianDeltaMb: 300 })
    expect(delta.controlSurfaceDelta).toEqual({ peakDeltaMb: 0, medianDeltaMb: 0 })
    expect(delta.workloadTotalDelta).toEqual({ peakDeltaMb: 360, medianDeltaMb: 300 })
  })
})

describe('judgeBracket', () => {
  it('is INCONCLUSIVE when free-memory drift is at least as large as the delta', () => {
    const run = { freeMb: { before: 1000, after: 950 }, unreadableLines: 0 }
    const verdict = judgeBracket(run, 30)
    expect(verdict.verdict).toBe('INCONCLUSIVE')
  })

  it('is OK when free-memory drift is smaller than the delta', () => {
    const run = { freeMb: { before: 1000, after: 950 }, unreadableLines: 0 }
    const verdict = judgeBracket(run, 100)
    expect(verdict.verdict).toBe('OK')
  })

  it('is INCONCLUSIVE when the run has unreadable lines, regardless of drift', () => {
    const run = { freeMb: { before: 1000, after: 999 }, unreadableLines: 2 }
    const verdict = judgeBracket(run, 100)
    expect(verdict.verdict).toBe('INCONCLUSIVE')
  })
})

describe('summarizeLatencies', () => {
  it('is UNJUDGED with fewer than 5 values', () => {
    const result = summarizeLatencies([100, 120, 90, 110], { instrument: 'marker-echo', resolutionMs: 1 })
    expect(result.verdict).toBe('UNJUDGED')
  })

  it('is MEASURED with 5+ values, reporting medianMs/minMs/maxMs/iqrMs and echoing the instrument/resolution', () => {
    const result = summarizeLatencies([100, 120, 90, 110, 105], { instrument: 'marker-echo', resolutionMs: 1 })
    expect(result.verdict).toBe('MEASURED')
    expect(result.medianMs).toBe(105)
    expect(result.minMs).toBe(90)
    expect(result.maxMs).toBe(120)
    expect(result.iqrMs).toBe(10)
    expect(result.instrument).toBe('marker-echo')
    expect(result.resolutionMs).toBe(1)
  })
})

describe('FAMILY_PATTERNS', () => {
  it('is frozen data covering every family named in the plan', () => {
    expect(Object.isFrozen(FAMILY_PATTERNS)).toBe(true)
    const families = FAMILY_PATTERNS.map((f) => f.family).sort()
    expect(families).toEqual(
      ['claude', 'codex', 'esbuild', 'indexer', 'orca-cli', 'tsc', 'vitest', 'workload-wrapper'].sort()
    )
  })
})
