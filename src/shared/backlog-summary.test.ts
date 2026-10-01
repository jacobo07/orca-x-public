import { describe, expect, it } from 'vitest'

import { BACKLOG_SUMMARY_TEXT_MAX } from './backlog-rpc-limits'
import {
  BACKLOG_CLOSED_STATES,
  BACKLOG_LIST_VIEWS,
  BACKLOG_OPEN_STATES,
  isBacklogStateOpen,
  toBacklogItemSummary
} from './backlog-summary'
import { BACKLOG_ITEM_STATES, type BacklogItem } from './backlog-types'

function record(originalText: string): BacklogItem {
  return {
    schemaVersion: 1,
    id: 'bli_00000000-0000-4000-8000-000000000001',
    kind: 'idea',
    originalText,
    normalizedIntent: 'intent',
    projectRefs: [{ projectId: 'P', mapping: 'explicit', evidence: 'test' }],
    state: 'needs-triage',
    priority: 'high',
    dependencies: [],
    executorPolicy: null,
    sourceLinks: [{ kind: 'manual', ref: 'r', capturedAt: 1, candidateId: null }],
    executionLinks: [],
    evidence: [
      {
        id: 'ev1',
        class: 'OBSERVED',
        origin: 'tool',
        subject: 'gate',
        source: 'ci',
        ref: null,
        observedAt: 2
      }
    ],
    events: [{ id: 'e1', type: 'created', at: 1, data: {} }],
    mergedInto: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 2
  }
}

const codePoints = (text: string) => Array.from(text).length

describe('toBacklogItemSummary', () => {
  it('removes events and evidence and keeps every other field unchanged', () => {
    const full = record('short')
    const summary = toBacklogItemSummary(full)
    expect(Object.hasOwn(summary, 'events')).toBe(false)
    expect(Object.hasOwn(summary, 'evidence')).toBe(false)
    expect(Object.hasOwn(summary, 'textTruncated')).toBe(false)
    const { events: _events, evidence: _evidence, ...rest } = full
    expect(summary).toEqual(rest)
  })

  it('clips originalText to the cap on the code point and flags it', () => {
    expect(BACKLOG_SUMMARY_TEXT_MAX).toBe(2_000)
    const long = toBacklogItemSummary(record('a'.repeat(2_001)))
    expect(long.originalText).toBe('a'.repeat(2_000))
    expect(long.textTruncated).toBe(true)
    const exact = toBacklogItemSummary(record('b'.repeat(2_000)))
    expect(exact.originalText).toBe('b'.repeat(2_000))
    expect(Object.hasOwn(exact, 'textTruncated')).toBe(false)
  })

  it('cuts on a code-point boundary when the 2,000th code point is astral', () => {
    const text = `${'x'.repeat(1_999)}😀${'y'.repeat(10)}`
    const summary = toBacklogItemSummary(record(text))
    expect(codePoints(summary.originalText)).toBe(2_000)
    expect(summary.originalText.endsWith('😀')).toBe(true)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(summary.originalText)).toBe(false)
    expect(summary.textTruncated).toBe(true)
    // 2,000 astral code points are 4,000 UTF-16 units and must not be cut.
    const astral = toBacklogItemSummary(record('😀'.repeat(2_000)))
    expect(codePoints(astral.originalText)).toBe(2_000)
    expect(Object.hasOwn(astral, 'textTruncated')).toBe(false)
  })

  it('is idempotent over its own output', () => {
    const once = toBacklogItemSummary(record('z'.repeat(2_500)))
    expect(toBacklogItemSummary(once)).toEqual(once)
    const short = toBacklogItemSummary(record('short'))
    expect(toBacklogItemSummary(short)).toEqual(short)
  })
})

describe('open and closed backlog states', () => {
  it('defines Open as the nine states other than done, dismissed and superseded', () => {
    expect(BACKLOG_LIST_VIEWS).toEqual(['full', 'summary'])
    expect([...BACKLOG_CLOSED_STATES].sort()).toEqual(['dismissed', 'done', 'superseded'])
    expect(BACKLOG_OPEN_STATES).toEqual(
      BACKLOG_ITEM_STATES.filter(
        (state) => state !== 'done' && state !== 'dismissed' && state !== 'superseded'
      )
    )
    expect(BACKLOG_OPEN_STATES).toHaveLength(9)
  })

  it('partitions every state', () => {
    const open = new Set<string>(BACKLOG_OPEN_STATES)
    const closed = new Set<string>(BACKLOG_CLOSED_STATES)
    for (const state of BACKLOG_ITEM_STATES) {
      expect(open.has(state) !== closed.has(state), state).toBe(true)
    }
    expect(open.size + closed.size).toBe(BACKLOG_ITEM_STATES.length)
    expect(isBacklogStateOpen('dismissed')).toBe(false)
    expect(isBacklogStateOpen('needs-triage')).toBe(true)
  })
})
