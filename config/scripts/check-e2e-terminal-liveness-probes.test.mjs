import { describe, expect, it } from 'vitest'

import {
  diffLivenessBaseline,
  findTerminalLivenessProbes,
  parseLivenessBaseline,
  pruneLivenessBaseline,
  serializeLivenessBaseline
} from './check-e2e-terminal-liveness-probes.mjs'

const SPEC = 'tests/e2e/a.spec.ts'
const key = (callee, file = SPEC) => `${file}\t${callee}`

describe('findTerminalLivenessProbes', () => {
  it('flags a waitForTerminalOutput on an identifier the file echoed', () => {
    const src = [
      'const marker = `M_${Date.now()}`',
      'await execInTerminal(page, ptyId, `echo ${marker}`)',
      'await waitForTerminalOutput(page, marker)'
    ].join('\n')
    expect(findTerminalLivenessProbes(src).substring).toEqual([
      { callee: 'waitForTerminalOutput', line: 3 }
    ])
  })

  // Why the quote is accepted: `echo "${x}"` is the same liveness probe, measured in 3 real specs.
  it('flags the quoted echo form and a multi-line call', () => {
    const src = 'run(`echo "${marker}"`)\nawait waitForTerminalOutput(\n  page,\n  marker\n)'
    expect(findTerminalLivenessProbes(src).substring).toEqual([
      { callee: 'waitForTerminalOutput', line: 2 }
    ])
  })

  it('flags a literal marker passed to an echo-internal probe helper', () => {
    const src = "\n\nawait probeDirectWrite(page, ptyIds[0], 'DIRECT_RESTORED_OK', 15_000)"
    expect(findTerminalLivenessProbes(src).substring).toEqual([
      { callee: 'probeDirectWrite', line: 3 }
    ])
  })

  it('flags a literal whose token the file echoed', () => {
    const src =
      'send(`echo READY_${runId}`)\nawait waitForTerminalOutput(orcaPage, `READY_${runId}`)'
    expect(findTerminalLivenessProbes(src).substring).toHaveLength(1)
  })

  it('counts fresh-output probes as fresh, never as substring', () => {
    const src = [
      "await probeDirectWriteOutput(page, ptyId, 'X')",
      "await mainProbeTransportPasteOutput(app, ptyId, 'Y')"
    ].join('\n')
    const found = findTerminalLivenessProbes(src)
    expect(found.substring).toEqual([])
    expect(found.fresh.map((site) => site.callee)).toEqual([
      'probeDirectWriteOutput',
      'mainProbeTransportPasteOutput'
    ])
  })

  it('does not count a wait on text the file never echoed', () => {
    const src =
      "await waitForTerminalOutput(page, 'OpenAI Codex')\nawait waitForTerminalOutput(page, url)"
    expect(findTerminalLivenessProbes(src).substring).toEqual([])
  })

  it('ignores definitions and the ForPtyId sibling', () => {
    const src = [
      'export async function probeDirectWrite(page, ptyId, marker) {}',
      'export async function waitForTerminalOutput(page, marker) {}',
      'run(`echo ${marker}`)',
      'await waitForTerminalOutputForPtyId(page, id, marker)'
    ].join('\n')
    expect(findTerminalLivenessProbes(src).substring).toEqual([])
  })
})

describe('diffLivenessBaseline', () => {
  it('reports a planted new site as growth', () => {
    const measured = new Map([
      [key('waitForTerminalOutput'), 1],
      [key('probeDirectWrite', 'tests/e2e/zz-plant.spec.ts'), 1]
    ])
    const baseline = new Map([[key('waitForTerminalOutput'), 1]])
    const { growth, stale } = diffLivenessBaseline(measured, baseline)
    expect(growth).toEqual([
      { key: key('probeDirectWrite', 'tests/e2e/zz-plant.spec.ts'), measured: 1, baseline: 0 }
    ])
    expect(stale).toEqual([])
  })

  it('reports a count above the baseline as growth', () => {
    const { growth } = diffLivenessBaseline(
      new Map([[key('waitForTerminalOutput'), 3]]),
      new Map([[key('waitForTerminalOutput'), 2]])
    )
    expect(growth).toEqual([{ key: key('waitForTerminalOutput'), measured: 3, baseline: 2 }])
  })

  it('reports a pruned-away site still in the baseline as stale', () => {
    const { growth, stale } = diffLivenessBaseline(
      new Map(),
      new Map([[key('probeKeyboardType'), 1]])
    )
    expect(growth).toEqual([])
    expect(stale).toEqual([{ key: key('probeKeyboardType'), measured: 0, baseline: 1 }])
  })

  it('reports a count below the baseline as stale', () => {
    const { stale } = diffLivenessBaseline(
      new Map([[key('waitForTerminalOutput'), 1]]),
      new Map([[key('waitForTerminalOutput'), 2]])
    )
    expect(stale).toEqual([{ key: key('waitForTerminalOutput'), measured: 1, baseline: 2 }])
  })

  it('is clean when measured equals the baseline', () => {
    const same = new Map([[key('waitForTerminalOutput'), 2]])
    expect(diffLivenessBaseline(same, new Map(same))).toEqual({ growth: [], stale: [] })
  })
})

describe('pruneLivenessBaseline', () => {
  it('drops gone keys and lowers counts, never adds or raises', () => {
    const pruned = pruneLivenessBaseline(
      new Map([
        ['a', 1],
        ['c', 4]
      ]),
      new Map([
        ['a', 2],
        ['b', 1]
      ])
    )
    expect([...pruned]).toEqual([['a', 1]])
  })
})

describe('baseline file', () => {
  it('round-trips through serialize and parse, skipping the header', () => {
    const entries = new Map([[key('waitForTerminalOutput'), 2]])
    const text = serializeLivenessBaseline(entries)
    expect(text.split('\n').filter((line) => line.startsWith('#'))).toHaveLength(4)
    expect(parseLivenessBaseline(text)).toEqual(entries)
  })

  it('rejects a malformed line instead of skipping it', () => {
    expect(() => parseLivenessBaseline(`${SPEC} waitForTerminalOutput 1\n`)).toThrow(/line 1/)
  })
})
