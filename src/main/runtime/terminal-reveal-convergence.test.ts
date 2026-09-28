import { describe, expect, it } from 'vitest'
import {
  compareRevealConvergence,
  REVEAL_CONVERGENCE_MAX_ROWS
} from './terminal-reveal-convergence'

const CANARY = 'CANARY terminal content that must never leave the probe'

function compare(mirror: string[] | null, renderer: string[] | null, moved = false) {
  return compareRevealConvergence({
    mirror: mirror ? { lines: mirror } : null,
    renderer: renderer ? { lines: renderer } : null,
    mirrorSequenceBefore: 10,
    mirrorSequenceAfter: moved ? 11 : 10
  })
}

describe('compareRevealConvergence', () => {
  it('converges when the pane shows what the mirror holds, ignoring trailing padding (control)', () => {
    expect(compare(['$ ls', 'a b c', '', ''], ['$ ls   ', 'a b c'])).toEqual({
      verdict: 'converged',
      rows: 2
    })
  })

  it('flags output that reached the mirror after a faithful restore but never reached the pane', () => {
    const verdict = compare(['$ make', 'built ok', '$ '], ['$ make'])
    expect(verdict.verdict).toBe('diverged')
    expect(verdict.verdict === 'diverged' && verdict.divergentRows).toEqual([1, 2])
  })

  it('flags a frozen pane whose reveal triggered no restore', () => {
    const verdict = compare(['$ top', 'load 0.42'], ['$ top', 'load 0.17'])
    expect(verdict.verdict === 'diverged' && verdict.divergentRows).toEqual([1])
  })

  it('carries no terminal text, only row indices and digests', () => {
    const verdict = compare([CANARY, 'x'], [CANARY, 'y'])
    expect(verdict.verdict).toBe('diverged')
    expect(JSON.stringify(verdict)).not.toContain('CANARY')
  })

  it('does not judge when output landed while the pane was being read', () => {
    expect(compare(['a'], ['b'], true)).toEqual({ verdict: 'unknown', reason: 'moving' })
  })

  it('keeps a failed read apart from an empty screen', () => {
    expect(compare(null, [])).toEqual({ verdict: 'unknown', reason: 'mirror-unavailable' })
    expect(compare([], null)).toEqual({ verdict: 'unknown', reason: 'renderer-unavailable' })
    expect(compare([], [])).toEqual({ verdict: 'converged', rows: 0 })
  })

  it('bounds the work to a fixed number of rows', () => {
    const tall = Array.from({ length: REVEAL_CONVERGENCE_MAX_ROWS + 50 }, (_, i) => `row ${i}`)
    const drifted = [...tall]
    drifted[REVEAL_CONVERGENCE_MAX_ROWS + 10] = 'beyond the bound'
    expect(compare(tall, drifted).verdict).toBe('converged')
  })
})
