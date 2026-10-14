import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  REPLICA_UNKNOWN_REASONS,
  deriveReplicaRelation,
  isReplicaRelationHealthy,
  type ReplicaFacts,
  type ReplicaPairEvidence,
  type ReplicaRelation,
  type TipFact,
  type WorktreeFact
} from './workspace-replica-state'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)
const clean: WorktreeFact = { kind: 'clean' }
const dirty: WorktreeFact = { kind: 'dirty', staged: 1, unstaged: 0, untracked: 0, unmerged: 0 }
const wtUnknown: WorktreeFact = { kind: 'unknown', reason: 'status failed' }

function facts(
  tip: TipFact,
  worktree: WorktreeFact = clean,
  hostId = 'h'
): Extract<ReplicaFacts, { setupId: string }> {
  return { setupId: `s-${hostId}`, hostId, tip, worktree }
}
const commit = (sha: string): TipFact => ({ kind: 'commit', sha, ref: 'refs/heads/main' })
const ev = (
  tips: readonly [string, string],
  outcome: ReplicaPairEvidence['outcome'],
  observedAt?: number
): ReplicaPairEvidence => ({ observedTips: tips, site: 'local', outcome, observedAt })

describe('deriveReplicaRelation', () => {
  it('reason list is the closed list of 14', () => {
    expect([...REPLICA_UNKNOWN_REASONS]).toEqual([
      'host-unreachable', 'tip-unknown', 'unborn', 'relay-too-old', 'transport-unsupported-host',
      'no-comparison-site', 'bundle-too-large', 'bundle-verify-failed', 'bundle-heads-mismatch',
      'transfer-interrupted', 'shallow', 'evidence-stale', 'not-compared', 'not-a-git-repo'
    ])
  })

  it('equal tips are same without evidence', () => {
    const r = deriveReplicaRelation(facts(commit(SHA_A)), facts({ kind: 'detached', sha: SHA_A }))
    expect(r).toEqual({ kind: 'same', observedTips: [SHA_A, SHA_A] })
  })

  it('differing tips without evidence are not-compared, never same', () => {
    expect(deriveReplicaRelation(facts(commit(SHA_A)), facts(commit(SHA_B)))).toEqual({
      kind: 'unknown',
      reason: 'not-compared'
    })
  })

  it('missing evidence inputs are unknown, never healthy', () => {
    const ok = facts(commit(SHA_A))
    const cases: [ReplicaFacts, ReplicaFacts, string][] = [
      [{ kind: 'folder' }, ok, 'not-a-git-repo'],
      [ok, { kind: 'folder' }, 'not-a-git-repo'],
      [facts({ kind: 'unknown', reason: 'host-unreachable' }), ok, 'host-unreachable'],
      [ok, facts({ kind: 'unknown', reason: 'timeout' }), 'tip-unknown'],
      [facts({ kind: 'unborn' }), ok, 'unborn'],
      [ok, facts({ kind: 'unborn' }), 'unborn']
    ]
    for (const [a, b, reason] of cases) {
      const r = deriveReplicaRelation(a, b)
      expect(r).toEqual({ kind: 'unknown', reason })
      expect(isReplicaRelationHealthy(r, a, b)).toBe(false)
    }
  })

  it('failed evidence maps to its unknown reason', () => {
    const a = facts(commit(SHA_A))
    const b = facts(commit(SHA_B))
    for (const reason of ['shallow', 'bundle-verify-failed', 'relay-too-old']) {
      const r = deriveReplicaRelation(a, b, ev([SHA_A, SHA_B], { ok: false, reason }))
      expect(r).toEqual({ kind: 'unknown', reason })
    }
    const odd = deriveReplicaRelation(a, b, ev([SHA_A, SHA_B], { ok: false, reason: 'weird' }))
    expect(odd.kind).toBe('unknown')
  })

  it('returns each ancestry result with its observed tips and site', () => {
    const a = facts(commit(SHA_A))
    const b = facts(commit(SHA_B))
    const t = [SHA_A, SHA_B] as const
    expect(deriveReplicaRelation(a, b, ev(t, { ok: true, ancestry: { kind: 'ahead', count: 2 } })))
      .toEqual({ kind: 'ahead', count: 2, observedTips: t, site: 'local' })
    expect(deriveReplicaRelation(a, b, ev(t, { ok: true, ancestry: { kind: 'behind', count: 3 } })).kind)
      .toBe('behind')
    const d = deriveReplicaRelation(
      a, b,
      ev(t, { ok: true, ancestry: { kind: 'diverged', mergeBase: SHA_C, aheadCount: 1, behindCount: 2 } })
    )
    expect(d).toMatchObject({ kind: 'diverged', mergeBase: SHA_C, aheadCount: 1, behindCount: 2 })
    expect(deriveReplicaRelation(a, b, ev(t, { ok: true, ancestry: { kind: 'unrelated' } })).kind)
      .toBe('unrelated')
  })

  it('moved tip makes evidence stale (seeded from valid evidence)', () => {
    const a = facts(commit(SHA_A))
    const evidence = ev([SHA_A, SHA_B], { ok: true, ancestry: { kind: 'ahead', count: 1 } })
    expect(deriveReplicaRelation(a, facts(commit(SHA_B)), evidence).kind).toBe('ahead')
    expect(deriveReplicaRelation(a, facts(commit(SHA_C)), evidence)).toEqual({
      kind: 'unknown',
      reason: 'evidence-stale'
    })
  })

  it('timestamps that disagree with the evidence do not decide', () => {
    const a = facts(commit(SHA_A))
    const b = facts(commit(SHA_B))
    const t = [SHA_A, SHA_B] as const
    // Evidence: A is BEHIND B. Timestamps claim A was observed later / newer.
    const older = ev(t, { ok: true, ancestry: { kind: 'behind', count: 4 } }, 9_999_999)
    const newer = ev(t, { ok: true, ancestry: { kind: 'behind', count: 4 } }, 1)
    expect(deriveReplicaRelation(a, b, older).kind).toBe('behind')
    expect(deriveReplicaRelation(a, b, newer).kind).toBe('behind')
    // Swapped replicas: same timestamps, opposite evidence -> opposite decision.
    const swapped = ev([SHA_B, SHA_A], { ok: true, ancestry: { kind: 'ahead', count: 4 } }, 1)
    expect(deriveReplicaRelation(b, a, swapped).kind).toBe('ahead')
    // Differing only in observedAt, results are identical apart from nothing time-related.
    expect(deriveReplicaRelation(a, b, older)).toEqual(deriveReplicaRelation(a, b, newer))
  })
})

const KINDS: ReplicaRelation['kind'][] = ['same', 'ahead', 'behind', 'diverged', 'unrelated', 'unknown']
function relationOf(kind: ReplicaRelation['kind'], tips: readonly [string, string]): ReplicaRelation {
  switch (kind) {
    case 'same': return { kind, observedTips: tips }
    case 'ahead': return { kind, count: 1, observedTips: tips }
    case 'behind': return { kind, count: 1, observedTips: tips }
    case 'diverged': return { kind, mergeBase: SHA_C, aheadCount: 1, behindCount: 1, observedTips: tips }
    case 'unrelated': return { kind, observedTips: tips }
    case 'unknown': return { kind, reason: 'not-compared' }
  }
}

/** Returns the cells where `pred` disagrees with the D-04 table. */
function tableViolations(pred: typeof isReplicaRelationHealthy): string[] {
  const bad: string[] = []
  for (const kind of KINDS) {
    for (const wa of [clean, dirty, wtUnknown]) {
      for (const wb of [clean, dirty, wtUnknown]) {
        for (const stale of [false, true]) {
          const a = facts(commit(SHA_A), wa)
          const b = facts(commit(stale ? SHA_C : SHA_A), wb)
          const rel = relationOf(kind, [SHA_A, SHA_A])
          const expected = kind === 'same' && wa.kind === 'clean' && wb.kind === 'clean' && !stale
          if (pred(rel, a, b) !== expected) {
            bad.push(`${kind}/${wa.kind}/${wb.kind}/${stale ? 'stale' : 'current'}`)
          }
        }
      }
    }
  }
  return bad
}

describe('isReplicaRelationHealthy', () => {
  it('matches the exhaustive relation x worktree x staleness table', () => {
    expect(tableViolations(isReplicaRelationHealthy)).toEqual([])
  })

  it('unknown is never healthy', () => {
    const a = facts(commit(SHA_A))
    expect(isReplicaRelationHealthy({ kind: 'unknown', reason: 'not-compared' }, a, a)).toBe(false)
  })

  it('a folder is never healthy', () => {
    const a = facts(commit(SHA_A))
    const rel = relationOf('same', [SHA_A, SHA_A])
    expect(isReplicaRelationHealthy(rel, a, { kind: 'folder' })).toBe(false)
  })

  it('a healthy same goes unhealthy when one tip moves', () => {
    const a = facts(commit(SHA_A))
    const b = facts(commit(SHA_A))
    const rel = deriveReplicaRelation(a, b)
    expect(isReplicaRelationHealthy(rel, a, b)).toBe(true)
    expect(isReplicaRelationHealthy(rel, a, facts(commit(SHA_B)))).toBe(false)
  })

  it('mutant: unknown treated as healthy goes red', () => {
    const mutant: typeof isReplicaRelationHealthy = (rel, a, b) =>
      rel.kind === 'unknown' || isReplicaRelationHealthy(rel, a, b)
    const bad = tableViolations(mutant)
    expect(bad.length).toBeGreaterThan(0)
    expect(bad.every((c) => c.startsWith('unknown/'))).toBe(true)
  })

  it('mutant: ahead treated as healthy goes red', () => {
    const mutant: typeof isReplicaRelationHealthy = (rel, a, b) =>
      rel.kind === 'ahead' || isReplicaRelationHealthy(rel, a, b)
    expect(tableViolations(mutant).length).toBeGreaterThan(0)
  })

  it('mutant: no staleness re-check goes red', () => {
    const mutant: typeof isReplicaRelationHealthy = (rel, a, b) =>
      rel.kind === 'same' && isClean(a) && isClean(b)
    expect(tableViolations(mutant).length).toBeGreaterThan(0)
  })
})

function isClean(f: ReplicaFacts): boolean {
  return f.kind !== 'folder' && f.worktree.kind === 'clean'
}

const CLOCK = /\bDate\b|mtime|committerDate|performance\.now|observedAt\s*[<>=!]/
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('classifier reads no clock', () => {
  it('matcher has a positive control', () => {
    expect(CLOCK.test('const t = Date.now()')).toBe(true)
    expect(CLOCK.test('a.observedAt > b.observedAt')).toBe(true)
  })

  it('module source is pure', () => {
    const src = stripComments(readFileSync(join(__dirname, 'workspace-replica-state.ts'), 'utf8'))
    expect(CLOCK.test(src)).toBe(false)
    expect(src).not.toMatch(/from 'node:/)
  })
})
