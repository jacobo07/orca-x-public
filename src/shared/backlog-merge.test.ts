import { describe, expect, it } from 'vitest'

import {
  backlogSourceLinkFromCandidate,
  unionBacklogExecutionLinks,
  unionBacklogSourceLinks
} from './backlog-merge'
import type { BacklogCandidate, BacklogExecutionLink, BacklogSourceLink } from './backlog-types'

// Fixed-seed LCG so every run generates the same pairs.
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 2 ** 32
  }
}

const SOURCE_KINDS = ['manual', 'orca-conversation', 'codex-transcript'] as const
const EXEC_KINDS = ['orchestration-task', 'github-issue'] as const

function sourceLinks(next: () => number, count: number): BacklogSourceLink[] {
  const seen = new Set<string>()
  const links: BacklogSourceLink[] = []
  while (links.length < count) {
    const link: BacklogSourceLink = {
      kind: SOURCE_KINDS[Math.floor(next() * SOURCE_KINDS.length)],
      ref: `ref-${Math.floor(next() * 6)}`,
      capturedAt: Math.floor(next() * 1000),
      candidateId: next() < 0.5 ? null : `blc_${Math.floor(next() * 3)}`
    }
    const key = `${link.kind}|${link.ref}|${link.candidateId}`
    if (!seen.has(key)) {
      seen.add(key)
      links.push(link)
    }
  }
  return links
}

function execLinks(next: () => number, count: number): BacklogExecutionLink[] {
  const seen = new Set<string>()
  const links: BacklogExecutionLink[] = []
  while (links.length < count) {
    const link = {
      kind: EXEC_KINDS[Math.floor(next() * EXEC_KINDS.length)],
      ref: `task-${Math.floor(next() * 5)}`
    }
    if (!seen.has(`${link.kind}|${link.ref}`)) {
      seen.add(`${link.kind}|${link.ref}`)
      links.push(link)
    }
  }
  return links
}

const sourceKey = (link: BacklogSourceLink): string =>
  `${link.kind}|${link.ref}|${link.candidateId}`
const execKey = (link: BacklogExecutionLink): string => `${link.kind}|${link.ref}`

const SEEDS = [1, 7, 42, 1_234, 99_991, 31_337]

describe('unionBacklogSourceLinks', () => {
  it.each(SEEDS)('keeps every input link exactly once, survivor first (seed %i)', (seed) => {
    const next = rng(seed)
    const survivor = sourceLinks(next, 1 + Math.floor(next() * 4))
    const loser = sourceLinks(next, 1 + Math.floor(next() * 4))

    const union = unionBacklogSourceLinks(survivor, loser)

    const distinct = new Set([...survivor, ...loser].map(sourceKey))
    expect(union).toHaveLength(distinct.size)
    expect(new Set(union.map(sourceKey))).toEqual(distinct)
    expect(union.slice(0, survivor.length)).toEqual(survivor)
  })

  it('handles fully overlapping and fully disjoint inputs', () => {
    const next = rng(5)
    const a = sourceLinks(next, 3)
    expect(unionBacklogSourceLinks(a, a)).toEqual(a)
    const b: BacklogSourceLink[] = [{ kind: 'infinityops', ref: 'z', capturedAt: 1, candidateId: null }]
    expect(unionBacklogSourceLinks(a, b)).toEqual([...a, ...b])
  })
})

describe('unionBacklogExecutionLinks', () => {
  it.each(SEEDS)('keeps every input link exactly once, survivor first (seed %i)', (seed) => {
    const next = rng(seed)
    const survivor = execLinks(next, 1 + Math.floor(next() * 4))
    const loser = execLinks(next, 1 + Math.floor(next() * 4))

    const union = unionBacklogExecutionLinks(survivor, loser)

    const distinct = new Set([...survivor, ...loser].map(execKey))
    expect(union).toHaveLength(distinct.size)
    expect(new Set(union.map(execKey))).toEqual(distinct)
    expect(union.slice(0, survivor.length)).toEqual(survivor)
  })
})

describe('backlogSourceLinkFromCandidate', () => {
  it('carries the candidate source and the candidate id', () => {
    const candidate = {
      id: 'blc_0123456789abcdef0123456789abcdef',
      source: {
        kind: 'codex-transcript',
        ref: 'session-1',
        capturedAt: 77,
        adapter: 'codex',
        capabilityLevel: 'full'
      }
    } as BacklogCandidate
    expect(backlogSourceLinkFromCandidate(candidate)).toEqual({
      kind: 'codex-transcript',
      ref: 'session-1',
      capturedAt: 77,
      candidateId: 'blc_0123456789abcdef0123456789abcdef'
    })
  })
})
