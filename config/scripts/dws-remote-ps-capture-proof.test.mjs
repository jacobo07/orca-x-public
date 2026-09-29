import { describe, expect, it } from 'vitest'
import { extractRemoteProof } from './dws-remote-ps-capture-proof.mjs'

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

// The leg's own LEG-START identity: the vitest child (pid 106) spawned 3s before the capture.
const TEST_MARKER = {
  leg: 'test',
  childPid: '106',
  startUtc: '2026-09-27T23:59:57Z',
  endUtc: '2026-09-28T00:00:30Z',
  exit: '0'
}
const VITEST_CHILD_ROW =
  '     106     105 orca-svc 40960      3                  \\_ node node_modules/vitest/vitest.mjs run'
const AGENT_WRAPPER_ROW =
  '     107     104 orca-svc  8000      3              \\_ node config/scripts/dws-offload-workload.mjs agent --nonce abc --agent-kind claude'

describe('extractRemoteProof', () => {
  it('PASS: a vitest.mjs row whose ppid chain reaches servePid under orca-svc', () => {
    const capture = psForestBlock('2026-09-28T00:00:00Z', [...SERVE_TREE_ROWS, VITEST_CHILD_ROW])
    const result = extractRemoteProof(capture, { servePid: 100, legs: ['test'], markers: [TEST_MARKER] })
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
    const marker = { ...TEST_MARKER, childPid: '201' }
    const result = extractRemoteProof(capture, { servePid: 100, legs: ['test'], markers: [marker] })
    expect(result).toEqual([
      { leg: 'test', verdict: 'FAIL', reason: 'not under the serve tree and the leg child' }
    ])
  })

  it('UNJUDGED: no matching row in any block within the leg window (absence of a capture is not absence of the process)', () => {
    const capture = psForestBlock('2026-09-28T00:00:00Z', SERVE_TREE_ROWS)
    const result = extractRemoteProof(capture, { servePid: 100, legs: ['test'], markers: [TEST_MARKER] })
    expect(result).toEqual([{ leg: 'test', verdict: 'UNJUDGED', reason: 'not captured' }])
  })

  // WR-08: a leg is bound to its own child and window, never to a name alone.
  it('UNJUDGED: a leg with no LEG-START marker cannot be bound, even when a matching row exists', () => {
    const capture = psForestBlock('2026-09-28T00:00:00Z', [...SERVE_TREE_ROWS, VITEST_CHILD_ROW])
    const [result] = extractRemoteProof(capture, { servePid: 100, legs: ['test'] })
    expect(result.verdict).toBe('UNJUDGED')
    expect(result.reason).toContain('LEG-START')
  })

  it('does not PASS the agent leg on the wrapper row whose argv names claude', () => {
    const capture = psForestBlock('2026-09-28T00:00:00Z', [...SERVE_TREE_ROWS, AGENT_WRAPPER_ROW])
    const marker = { leg: 'agent', childPid: '108', startUtc: '2026-09-27T23:59:57Z', exit: '0' }
    const [result] = extractRemoteProof(capture, { servePid: 100, legs: ['agent'], markers: [marker] })
    expect(result).toEqual({ leg: 'agent', verdict: 'UNJUDGED', reason: 'not captured' })
  })

  it('PASSes the agent leg on the spawned claude child (positive control for the wrapper exclusion)', () => {
    const capture = psForestBlock('2026-09-28T00:00:00Z', [
      ...SERVE_TREE_ROWS,
      AGENT_WRAPPER_ROW,
      '     108     107 orca-svc 90000      3                  \\_ node /opt/claude/cli.js -p prompt'
    ])
    const marker = { leg: 'agent', childPid: '108', startUtc: '2026-09-27T23:59:57Z', exit: '0' }
    const [result] = extractRemoteProof(capture, { servePid: 100, legs: ['agent'], markers: [marker] })
    expect(result.verdict).toBe('PASS')
  })

  it('does not PASS on a lingering process that started before the leg', () => {
    const capture = psForestBlock('2026-09-28T00:00:00Z', [
      ...SERVE_TREE_ROWS,
      '     106     105 orca-svc 40960   3600                  \\_ node node_modules/vitest/vitest.mjs run'
    ])
    const [result] = extractRemoteProof(capture, { servePid: 100, legs: ['test'], markers: [TEST_MARKER] })
    expect(result).toEqual({
      leg: 'test',
      verdict: 'UNJUDGED',
      reason: 'only processes started outside the leg window'
    })
  })

  it('FAILs an in-window row under serve that is not the leg child', () => {
    const capture = psForestBlock('2026-09-28T00:00:00Z', [...SERVE_TREE_ROWS, VITEST_CHILD_ROW])
    const marker = { ...TEST_MARKER, childPid: '300' }
    const [result] = extractRemoteProof(capture, { servePid: 100, legs: ['test'], markers: [marker] })
    expect(result.verdict).toBe('FAIL')
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
