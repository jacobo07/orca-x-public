import { describe, expect, it } from 'vitest'
import {
  compareFreeMemoryThenFingerprint,
  rankMissionCandidates,
  type RankableCandidate
} from './placement-host-ranking'

const GB = 1024 ** 3

function candidate(fingerprint: string, memoryGb: number): RankableCandidate {
  return {
    key: `fingerprint:${fingerprint}`,
    fingerprint,
    availableMemory: memoryGb * GB,
    addresses: [`runtime:${fingerprint}`]
  }
}

function signals(hydrated: string[], load: Record<string, number> = {}) {
  return {
    isHydrated: (c: RankableCandidate) => hydrated.includes(c.fingerprint),
    loadOf: (c: RankableCandidate) => load[c.fingerprint] ?? 0
  }
}

const order = (list: readonly RankableCandidate[]) => list.map((c) => c.fingerprint)

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]]
  }
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest
    ])
  )
}

describe('compareFreeMemoryThenFingerprint', () => {
  it('puts more free memory first, then the lower fingerprint', () => {
    const list = [candidate('fp-b', 8), candidate('fp-z', 24), candidate('fp-a', 8)]
    expect(order([...list].sort(compareFreeMemoryThenFingerprint))).toEqual([
      'fp-z',
      'fp-a',
      'fp-b'
    ])
  })
})

describe('rankMissionCandidates', () => {
  const big = candidate('fp-big', 24)
  const small = candidate('fp-small', 8)

  it('puts a hydrated candidate before a roomier one', () => {
    expect(order(rankMissionCandidates([big, small], signals(['fp-small'])))).toEqual([
      'fp-small',
      'fp-big'
    ])
  })

  it('control: with nobody hydrated the roomier candidate is first', () => {
    expect(order(rankMissionCandidates([small, big], signals([])))).toEqual(['fp-big', 'fp-small'])
  })

  it('ranks hydration above load, as the decision states', () => {
    const ranked = rankMissionCandidates([big, small], signals(['fp-small'], { 'fp-small': 3 }))
    expect(order(ranked)).toEqual(['fp-small', 'fp-big'])
  })

  it('with equal hydration puts the lighter loaded candidate first, ahead of free memory', () => {
    const ranked = rankMissionCandidates([big, small], signals([], { 'fp-big': 1 }))
    expect(order(ranked)).toEqual(['fp-small', 'fp-big'])
  })

  it('with equal hydration and load puts more free memory first, then the lower fingerprint', () => {
    const tied = [candidate('fp-b', 8), candidate('fp-a', 8), big]
    expect(order(rankMissionCandidates(tied, signals([])))).toEqual(['fp-big', 'fp-a', 'fp-b'])
  })

  it('gives one order for every permutation of the input', () => {
    const list = [big, small, candidate('fp-a', 8), candidate('fp-mid', 16)]
    const wanted = order(rankMissionCandidates(list, signals(['fp-small'], { 'fp-mid': 1 })))
    for (const shuffled of permutations(list)) {
      expect(
        order(rankMissionCandidates(shuffled, signals(['fp-small'], { 'fp-mid': 1 })))
      ).toEqual(wanted)
    }
    expect(wanted).toEqual(['fp-small', 'fp-big', 'fp-a', 'fp-mid'])
  })

  it('does not mutate its input', () => {
    const list = [small, big]
    rankMissionCandidates(list, signals([]))
    expect(order(list)).toEqual(['fp-small', 'fp-big'])
  })
})

// Why: D-15 states the order once; every adjacent pair here is decided by exactly one term, the one under test.
describe('mission ranking order table', () => {
  type Variant = {
    term: 'hydrated' | 'load' | 'free memory' | 'fingerprint'
    winner: RankableCandidate
    loser: RankableCandidate
    hydrated: string[]
    load: Record<string, number>
  }
  const variants: Variant[] = [
    {
      term: 'hydrated',
      winner: candidate('fp-hy', 1),
      loser: candidate('fp-aa', 64),
      hydrated: ['fp-hy'],
      load: { 'fp-hy': 9 }
    },
    {
      term: 'load',
      winner: candidate('fp-light', 1),
      loser: candidate('fp-roomy', 64),
      hydrated: [],
      load: { 'fp-roomy': 1 }
    },
    {
      term: 'free memory',
      winner: candidate('fp-zz', 16),
      loser: candidate('fp-aa', 8),
      hydrated: [],
      load: {}
    },
    {
      term: 'fingerprint',
      winner: candidate('fp-aa', 8),
      loser: candidate('fp-zz', 8),
      hydrated: [],
      load: {}
    }
  ]

  it.each(variants)('the $term term decides on its own', (variant) => {
    for (const input of [
      [variant.winner, variant.loser],
      [variant.loser, variant.winner]
    ]) {
      const ranked = rankMissionCandidates(input, signals(variant.hydrated, variant.load))
      expect(order(ranked)).toEqual([variant.winner.fingerprint, variant.loser.fingerprint])
    }
  })

  it('orders five candidates exactly: hydrated, then least load, then most memory, then fingerprint', () => {
    const list = [
      candidate('fp-e', 8),
      candidate('fp-d', 8),
      candidate('fp-c', 24),
      candidate('fp-b', 2),
      candidate('fp-a', 1)
    ]
    const hydrated = ['fp-a']
    const load = { 'fp-a': 7, 'fp-c': 1, 'fp-d': 1, 'fp-e': 1 }
    const wanted = ['fp-a', 'fp-b', 'fp-c', 'fp-d', 'fp-e']
    for (const shuffled of permutations(list)) {
      expect(order(rankMissionCandidates(shuffled, signals(hydrated, load)))).toEqual(wanted)
    }
  })

  it('does not know which candidate is the current host', () => {
    const list = [{ ...candidate('fp-z', 8), isCurrent: true }, candidate('fp-a', 8)]
    expect(order(rankMissionCandidates(list, signals([])))).toEqual(['fp-a', 'fp-z'])
  })
})
