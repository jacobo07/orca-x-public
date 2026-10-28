import { describe, expect, it } from 'vitest'
import { extractTickSet, judgeBackfill, parseTickLine } from './dws-backfill-verdict.mjs'

const NONCE = 'abc123def456'

function buffer(ticks) {
  return ticks.map((n) => `DWS-TICK-${NONCE}-${n} 12:00:${String(n % 60).padStart(2, '0')}`).join('\r\n')
}

function range(from, to) {
  const out = []
  for (let n = from; n <= to; n += 1) {
    out.push(n)
  }
  return out
}

describe('judgeBackfill', () => {
  const base = { nonce: NONCE, lQuitExit: 100, lAttach0: 160, readerLive: true }

  it('PASS: the unattached window is replayed hole-free, then live ticks continue', () => {
    const result = judgeBackfill({ ...base, content: buffer(range(90, 175)) })
    expect(result.verdict).toBe('PASS')
    expect(result.visibleInWindow).toBe(60)
    expect(result.truncatedAtOldestEnd).toBe(false)
  })

  // The defect this replaces: `max visible tick > tick at quit` passed for a client that received
  // NO replay and only saw live ticks emitted after it attached.
  it('FAIL: a live-only client (no replay) is not a back-fill, even though its max tick exceeds the tick at quit', () => {
    const result = judgeBackfill({ ...base, content: buffer(range(165, 175)) })
    expect(Math.max(...extractTickSet(buffer(range(165, 175)), NONCE))).toBeGreaterThan(base.lQuitExit)
    expect(result.verdict).toBe('FAIL')
    expect(result.reason).toContain('none of the')
  })

  it('FAIL: a synthetic buffer with a hole in the unattached window', () => {
    const ticks = range(90, 175).filter((n) => n !== 130)
    const result = judgeBackfill({ ...base, content: buffer(ticks) })
    expect(result.verdict).toBe('FAIL')
    expect(result.reason).toContain('gap')
    expect(result.reason).toContain('130')
  })

  it('FAIL: the newest pre-attach tick is not visible (replay incomplete at the newest end)', () => {
    const result = judgeBackfill({ ...base, content: buffer([...range(90, 159), ...range(165, 175)]) })
    expect(result.verdict).toBe('FAIL')
    expect(result.reason).toContain('160')
  })

  it('PASS with a recorded truncation when scrollback pruned the oldest unattached ticks', () => {
    const result = judgeBackfill({ ...base, content: buffer(range(140, 175)) })
    expect(result.verdict).toBe('PASS')
    expect(result.truncatedAtOldestEnd).toBe(true)
    expect(result.reason).toContain('scrollback')
  })

  it('INCONCLUSIVE when the reader was not proven live', () => {
    const result = judgeBackfill({ ...base, readerLive: false, content: buffer(range(90, 175)) })
    expect(result.verdict).toBe('INCONCLUSIVE')
  })

  it('INCONCLUSIVE, never PASS, when continuity.json recorded no tick at quit exit', () => {
    const result = judgeBackfill({ ...base, lQuitExit: null, content: buffer(range(90, 175)) })
    expect(result.verdict).toBe('INCONCLUSIVE')
    expect(result.reason).toContain('tQuitExitLine')
  })

  it('INCONCLUSIVE when the pre-attach tail could not be parsed', () => {
    const result = judgeBackfill({ ...base, lAttach0: null, content: buffer(range(90, 175)) })
    expect(result.verdict).toBe('INCONCLUSIVE')
  })

  it('INCONCLUSIVE when no tick was emitted while unattached (empty window)', () => {
    const result = judgeBackfill({ ...base, lAttach0: 100, content: buffer(range(90, 175)) })
    expect(result.verdict).toBe('INCONCLUSIVE')
  })

  it('ignores ticks from another run (different nonce)', () => {
    const foreign = range(101, 160)
      .map((n) => `DWS-TICK-otherNonce00-${n} 12:00:00`)
      .join('\r\n')
    const result = judgeBackfill({ ...base, content: `${foreign}\r\n${buffer(range(165, 175))}` })
    expect(result.verdict).toBe('FAIL')
  })
})

describe('parseTickLine', () => {
  it('reads the tick number for this nonce only', () => {
    expect(parseTickLine(`DWS-TICK-${NONCE}-42 12:00:01`, NONCE)).toBe(42)
    expect(parseTickLine('DWS-TICK-other-42 12:00:01', NONCE)).toBeNull()
    expect(parseTickLine('', NONCE)).toBeNull()
  })
})
