import { describe, expect, it } from 'vitest'
import {
  FAMILY_PATTERNS,
  classifyRun,
  computeDelta,
  extractRemoteProof,
  judgeAbsence,
  judgeBracket,
  legWindowFromManifest,
  observationDefects,
  parseSamples,
  redactCommandLine,
  redactSecrets,
  subtreePids,
  summarizeLatencies,
  summarizeRun
} from './dws-offload-measurement.mjs'

// A run that was genuinely observed end to end; hand-built summaries spread this in so the verdicts
// under test are about the family/bracket, not about observation validity.
const OBSERVED = {
  observation: {
    samples: 10,
    sawStart: true,
    sawStop: true,
    spanMs: 9000,
    desktopRootPidValid: true,
    legWindowCovered: null
  },
  freeMb: { before: 5000, after: 4990, min: 4990 }
}

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

  it('redacts the URL-encoded web-client fragment form', () => {
    const out = redactCommandLine(
      'msedge http://127.0.0.1:6791/web-index.html#pairing=orca%3A%2F%2Fpair%3Fcode%3Dsecret123 --headless'
    )
    expect(out).not.toContain('secret123')
    expect(out).toContain('--headless')
  })
})

describe('redactSecrets', () => {
  const webClientUrl = 'http://127.0.0.1:6791/#pairing=orca%3A%2F%2Fpair%3Fcode%3Dsecret123'

  it('scrubs a Playwright timeout message and call log that quote the navigated URL', () => {
    const message = `page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "${webClientUrl}", waiting until "domcontentloaded"`
    const out = redactSecrets(message, [webClientUrl])
    expect(out).not.toContain('secret123')
    expect(out).not.toContain('orca%3A')
    expect(out).toContain('Timeout 30000ms exceeded')
  })

  it('scrubs an exact known secret whose shape no pattern anticipates', () => {
    const out = redactSecrets('failed for https://host/x?blob=UNPATTERNED-SECRET', ['https://host/x?blob=UNPATTERNED-SECRET'])
    expect(out).not.toContain('UNPATTERNED-SECRET')
  })

  it('leaves an ordinary error message intact (green control)', () => {
    expect(redactSecrets('tick-loop terminal tab not found', [webClientUrl])).toBe('tick-loop terminal tab not found')
    expect(redactSecrets(undefined)).toBe('')
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

  // Regression for a real incident (2026-09-28, this plan's own baseline run): a pid was an
  // unrelated `.claude/hooks/anti-thrash.js` process in an early sample, exited, and was reused by
  // the REAL vitest.mjs process ~137s later in the same run. A per-pid-for-the-whole-run
  // classification cache would attribute every later sample's bytes to the EARLY, unrelated
  // process's identity -- silently zeroing the positive control this instrument exists to prove
  // (CTX-MEAS-3) while folding the bytes into `control-surface` instead (still "plausible"-looking,
  // which is exactly what makes this class of bug dangerous).
  it('classifies a reused pid by whichever process actually held it at each sample, not by the pid\'s first-ever sighting', () => {
    const desktop100 = { pid: 100, ppid: 1, name: 'electron.exe', commandLine: '"C:\\orca\\electron.exe" .' }
    const reusedPid = 35888
    const samples = [
      makeSample({
        monoMs: 0,
        freeMb: 5000,
        procs: [
          makeProc({ ...desktop100, workingSetMb: 200 }),
          // Early sample: an unrelated background hook process, briefly holding this pid.
          makeProc({ pid: reusedPid, ppid: 1, name: 'node.exe', commandLine: 'node .claude/hooks/anti-thrash.js', workingSetMb: 12 })
        ]
      }),
      makeSample({
        monoMs: 1000,
        freeMb: 4995,
        // The hook process has exited; nothing holds the pid this sample.
        procs: [makeProc({ ...desktop100, workingSetMb: 200 })]
      }),
      makeSample({
        monoMs: 2000,
        freeMb: 4990,
        procs: [
          makeProc({ ...desktop100, workingSetMb: 200 }),
          // The pid is reused by the real vitest.mjs process, inside the desktop subtree.
          makeProc({ pid: reusedPid, ppid: 100, name: 'node.exe', commandLine: 'node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts x.test.mjs', workingSetMb: 310 })
        ]
      })
    ]
    const summary = summarizeRun(samples, { desktopRootPid: 100, nonce: 'NONCE-UNUSED', harnessRootPids: [] })

    expect(summary.perFamily.vitest.maxCount).toBe(1)
    expect(summary.perFamily.vitest.peakMb).toBe(310)
    // The early, unrelated occupant must not be folded into control-surface either -- it matches
    // no family and is outside THAT SAMPLE's desktop subtree, so it is correctly 'background'.
    // Only the desktop root itself (pid 100, present every sample) is control-surface.
    expect(summary.perFamily['control-surface'].observed).toEqual([
      { pid: 100, commandLine: '"C:\\orca\\electron.exe" .' }
    ])
  })
})

describe('judgeAbsence', () => {
  it('is PASS when the baseline saw the family (positive control) and the offload saw none', () => {
    const baseline = { perFamily: { codex: { maxCount: 1, observed: [{ pid: 10, commandLine: 'codex.exe' }] } } }
    const offload = { ...OBSERVED, perFamily: { codex: { maxCount: 0, observed: [] } } }
    const verdict = judgeAbsence(baseline, offload, 'codex')
    expect(verdict.verdict).toBe('PASS')
  })

  // A sampler that died (or never sampled) reports zero for every family, exactly like a clean
  // offload. Every case below would have been PASS before observation validity was checked.
  describe('is INCONCLUSIVE, never PASS, when the offload run was not validly observed', () => {
    const baseline = { perFamily: { codex: { maxCount: 1, observed: [{ pid: 10, commandLine: 'codex.exe' }] } } }
    const emptyOffload = (overrides) => ({
      ...OBSERVED,
      ...overrides,
      perFamily: { codex: { maxCount: 0, observed: [] } }
    })

    it('for a stream with zero samples (summarizeRun([]))', () => {
      const offload = summarizeRun([], { desktopRootPid: 100, sawStart: true, sawStop: true })
      const verdict = judgeAbsence(baseline, offload, 'codex')
      expect(verdict.verdict).toBe('INCONCLUSIVE')
      expect(verdict.reason).toContain('sample')
    })

    it('for a stream with no sampler-stop record (died mid-run)', () => {
      const offload = emptyOffload({ observation: { ...OBSERVED.observation, sawStop: false } })
      const verdict = judgeAbsence(baseline, offload, 'codex')
      expect(verdict.verdict).toBe('INCONCLUSIVE')
      expect(verdict.reason).toContain('sampler-stop')
    })

    it('for a stream with no sampler-start record', () => {
      const offload = emptyOffload({ observation: { ...OBSERVED.observation, sawStart: false } })
      expect(judgeAbsence(baseline, offload, 'codex').verdict).toBe('INCONCLUSIVE')
    })

    it('for a stream that stops before the legs did', () => {
      const offload = emptyOffload({ observation: { ...OBSERVED.observation, legWindowCovered: false } })
      const verdict = judgeAbsence(baseline, offload, 'codex')
      expect(verdict.verdict).toBe('INCONCLUSIVE')
      expect(verdict.reason).toContain('legs window')
    })

    it('for a manifest whose desktopRootPid is not a positive integer', () => {
      const offload = emptyOffload({ observation: { ...OBSERVED.observation, desktopRootPidValid: false } })
      expect(judgeAbsence(baseline, offload, 'codex').verdict).toBe('INCONCLUSIVE')
    })

    it('for a summary with no observation record at all', () => {
      const offload = { perFamily: { codex: { maxCount: 0, observed: [] } } }
      expect(judgeAbsence(baseline, offload, 'codex').verdict).toBe('INCONCLUSIVE')
    })

    it('but still FAIL when the family was positively seen, even in an invalid run', () => {
      const offload = {
        perFamily: { codex: { maxCount: 1, observed: [{ pid: 9, commandLine: 'codex.exe' }] } }
      }
      expect(judgeAbsence(baseline, offload, 'codex').verdict).toBe('FAIL')
    })
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
    const run = { ...OBSERVED, freeMb: { before: 1000, after: 950 }, unreadableLines: 0 }
    const verdict = judgeBracket(run, 100)
    expect(verdict.verdict).toBe('OK')
  })

  // `|null - null| === 0` is smaller than any positive delta, so an empty stream used to bracket OK.
  it('is INCONCLUSIVE, never OK, for an empty sample stream', () => {
    const run = summarizeRun([], { desktopRootPid: 100, sawStart: true, sawStop: true })
    expect(run.freeMb).toEqual({ before: null, after: null, min: null })
    const verdict = judgeBracket(run, 100)
    expect(verdict.verdict).toBe('INCONCLUSIVE')
    expect(verdict.reason).toContain('sample')
  })

  it('is INCONCLUSIVE, never OK, for a truncated stream missing its sampler-stop record', () => {
    const run = { ...OBSERVED, observation: { ...OBSERVED.observation, sawStop: false }, unreadableLines: 0 }
    expect(judgeBracket(run, 100).verdict).toBe('INCONCLUSIVE')
  })

  it('is INCONCLUSIVE when the free-memory bracket is null even if the stream has samples', () => {
    const run = { ...OBSERVED, freeMb: { before: null, after: null, min: null }, unreadableLines: 0 }
    expect(judgeBracket(run, 100).verdict).toBe('INCONCLUSIVE')
  })

  // Positive control: a genuinely observed run built through summarizeRun still judges OK/PASS, so
  // the validity gate is not simply refusing everything.
  it('still judges a fully observed run end to end (positive control)', () => {
    const nonce = 'NONCE-XYZ'
    const samples = buildThreeSampleFixture(nonce)
    const legWindow = legWindowFromManifest({
      legs: [{ startUtc: samples[0].utc, endUtc: samples[2].utc }]
    })
    const offload = summarizeRun(samples, {
      desktopRootPid: 100,
      nonce,
      harnessRootPids: [600],
      sawStart: true,
      sawStop: true,
      legWindow
    })
    expect(observationDefects(offload)).toEqual([])
    expect(judgeBracket(offload, 1000).verdict).toBe('OK')
  })

  it('is INCONCLUSIVE when the stream ends before the legs did (legs window not covered)', () => {
    const samples = buildThreeSampleFixture('NONCE-XYZ')
    const lastMs = Date.parse(samples[2].utc)
    const offload = summarizeRun(samples, {
      desktopRootPid: 100,
      sawStart: true,
      sawStop: true,
      legWindow: { startMs: Date.parse(samples[0].utc), endMs: lastMs + 60_000 }
    })
    expect(offload.observation.legWindowCovered).toBe(false)
    expect(judgeBracket(offload, 1000).verdict).toBe('INCONCLUSIVE')
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

// Why a synthetic `ps --forest` transcript, not a real captured one: a drill pinned to a real
// GEX44 capture has an interest in that exact process tree staying unchanged (instrument-before-
// claim.md / monetary-quantity-integrity.md doctrine on synthetic fixtures). The column layout
// (`ps -o pid,ppid,user,rss,etimes,args --forest`) is confirmed against a real capture from GEX44
// (dws-gex44-serve-provision.sh's ps-capture subcommand) before writing this fixture.
function psForestBlock(utc, rows) {
  const header = '    PID    PPID USER       RSS ELAPSED COMMAND'
  return [`CAPTURE ${utc}`, header, ...rows].join('\n')
}

const SERVE_TREE_ROWS = [
  '     100       1 orca-svc  2000     10 /bin/sh /usr/bin/xvfb-run -a electron --serve',
  '     101     100 orca-svc  5000     10  \\_ Xvfb :100',
  '     102     100 orca-svc 20000     10  \\_ electron --serve',
  '     103     102 orca-svc 15000     10      \\_ electron out/main/daemon-entry.js',
  '     104     103 orca-svc  3000      9          \\_ /bin/bash --rcfile',
  '     105     104 orca-svc  8000      5              \\_ node config/scripts/dws-offload-workload.mjs test --nonce abc'
]

describe('extractRemoteProof', () => {
  it('PASS: a vitest.mjs row whose ppid chain reaches servePid under orca-svc', () => {
    const capture = psForestBlock('2026-09-28T00:00:00Z', [
      ...SERVE_TREE_ROWS,
      '     106     105 orca-svc 40960      3                  \\_ node node_modules/vitest/vitest.mjs run'
    ])
    const result = extractRemoteProof(capture, { servePid: 100, legs: ['test'] })
    expect(result).toEqual([
      {
        leg: 'test',
        verdict: 'PASS',
        firstSeenUtc: '2026-09-28T00:00:00Z',
        lastSeenUtc: '2026-09-28T00:00:00Z',
        peakRssMb: 40
      }
    ])
  })

  it('FAIL: a matching row whose chain does not reach servePid', () => {
    const capture = psForestBlock('2026-09-28T00:00:00Z', [
      ...SERVE_TREE_ROWS,
      '     200       1 orca-svc  1000      3 /bin/bash -lc some-other-shell',
      '     201     200 orca-svc 30000      2  \\_ node node_modules/vitest/vitest.mjs run'
    ])
    const result = extractRemoteProof(capture, { servePid: 100, legs: ['test'] })
    expect(result).toEqual([{ leg: 'test', verdict: 'FAIL', reason: 'not under the serve tree' }])
  })

  it('UNJUDGED: no matching row in any block within the leg window (absence of a capture is not absence of the process)', () => {
    const capture = psForestBlock('2026-09-28T00:00:00Z', SERVE_TREE_ROWS)
    const result = extractRemoteProof(capture, { servePid: 100, legs: ['test'] })
    expect(result).toEqual([{ leg: 'test', verdict: 'UNJUDGED', reason: 'not captured' }])
  })

  it('INCONCLUSIVE: a capture with zero CAPTURE blocks', () => {
    const result = extractRemoteProof('no capture markers here at all', {
      servePid: 100,
      legs: ['test', 'build']
    })
    expect(result).toEqual([
      { leg: 'test', verdict: 'INCONCLUSIVE', reason: 'unreadable capture' },
      { leg: 'build', verdict: 'INCONCLUSIVE', reason: 'unreadable capture' }
    ])
  })
})

describe('computeDelta absence verdicts', () => {
  it('attaches a per-family absence verdict (PASS only with a baseline positive control), pattern printed beside it', () => {
    const baseline = {
      perFamily: {
        vitest: { peakMb: 320, medianMb: 300, maxCount: 1 },
        esbuild: { peakMb: 0, medianMb: 0, maxCount: 0 },
        'control-surface': { peakMb: 350, medianMb: 350, maxCount: 10 }
      },
      workloadTotal: { peakMb: 360, medianMb: 300 }
    }
    const offload = {
      ...OBSERVED,
      perFamily: {
        vitest: { peakMb: 0, medianMb: 0, maxCount: 0 },
        esbuild: { peakMb: 0, medianMb: 0, maxCount: 0 },
        'control-surface': { peakMb: 350, medianMb: 350, maxCount: 10 }
      },
      workloadTotal: { peakMb: 0, medianMb: 0 }
    }
    const delta = computeDelta(baseline, offload)
    expect(delta.absenceByFamily.vitest.verdict).toBe('PASS')
    expect(delta.absenceByFamily.esbuild.verdict).toBe('UNJUDGED')
    expect(delta.bracket.verdict).toBe('OK')
    // Existing 02-03 shape is untouched by the addition.
    expect(delta.perFamily.vitest).toEqual({ peakDeltaMb: 320, medianDeltaMb: 300 })
  })

  it('an empty offload sample stream yields INCONCLUSIVE absence and bracket, not PASS/OK', () => {
    const baseline = {
      perFamily: { vitest: { peakMb: 320, medianMb: 300, maxCount: 1 } },
      workloadTotal: { peakMb: 360, medianMb: 300 }
    }
    const offload = summarizeRun([], { desktopRootPid: 100, sawStart: true, sawStop: true })
    const delta = computeDelta(baseline, offload)
    expect(delta.absenceByFamily.vitest.verdict).toBe('INCONCLUSIVE')
    expect(delta.bracket.verdict).toBe('INCONCLUSIVE')
  })
})

describe('legWindowFromManifest', () => {
  it('spans the legs that carry both stamps and ignores a TIMEOUT leg with no end', () => {
    const window = legWindowFromManifest({
      legs: [
        { leg: 'test', startUtc: '2026-09-28T00:00:10.000Z', endUtc: '2026-09-28T00:00:20.000Z' },
        { leg: 'build', startUtc: '2026-09-28T00:00:25.000Z', endUtc: '2026-09-28T00:00:40.000Z' },
        { leg: 'agent', startUtc: '2026-09-28T00:00:45.000Z', exit: 'TIMEOUT' }
      ]
    })
    expect(window).toEqual({
      startMs: Date.parse('2026-09-28T00:00:10.000Z'),
      endMs: Date.parse('2026-09-28T00:00:40.000Z')
    })
  })

  it('is null (unknown), never a fabricated window, when no leg carries both stamps', () => {
    expect(legWindowFromManifest({ legs: [{ leg: 'test', exit: 'TIMEOUT' }] })).toBeNull()
    expect(legWindowFromManifest({})).toBeNull()
  })
})
