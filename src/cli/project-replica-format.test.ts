import { describe, expect, it } from 'vitest'
import type { ReplicaPairCompareResult, ReplicaPairView } from '../shared/replica-pair-view'
import {
  deriveReplicaRelation,
  isReplicaRelationHealthy,
  type ReplicaFacts,
  type ReplicaRelation,
  type TipFact,
  type WorktreeFact
} from '../shared/workspace-replica-state'
import { formatReplicaCompare, formatReplicaRelation } from './project-replica-format'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)
const clean: WorktreeFact = { kind: 'clean' }
const dirty: WorktreeFact = { kind: 'dirty', staged: 1, unstaged: 0, untracked: 0, unmerged: 0 }
const unread: WorktreeFact = { kind: 'unknown', reason: 'remote-worktree-not-read' }
const tip: TipFact = { kind: 'commit', sha: SHA_A, ref: 'refs/heads/main' }

function facts(worktree: WorktreeFact): Exclude<ReplicaFacts, { kind: 'folder' }> {
  return { setupId: 's', hostId: 'h', tip, worktree }
}

function viewOf(setupId: string, relation: ReplicaRelation, healthy: boolean): ReplicaPairView {
  return { setupId, anchorSetupId: 'anchor', hostId: 'ssh:gex44' as never, relation, healthy }
}

function equalTipsView(
  setupId: string,
  local: WorktreeFact,
  remote: WorktreeFact
): ReplicaPairView {
  const a = facts(local)
  const b = facts(remote)
  const relation = deriveReplicaRelation(a, b)
  return viewOf(setupId, relation, isReplicaRelationHealthy(relation, a, b))
}

const ok = (...pairs: ReplicaPairView[]): ReplicaPairCompareResult => ({ status: 'ok', pairs })

describe('formatReplicaRelation', () => {
  it('prints each known relation as its word with counts', () => {
    const tips = [SHA_A, SHA_B] as const
    expect(formatReplicaRelation({ kind: 'same', observedTips: tips }, true)).toBe('same')
    expect(formatReplicaRelation({ kind: 'ahead', count: 3, observedTips: tips }, false)).toBe(
      'ahead 3'
    )
    expect(formatReplicaRelation({ kind: 'behind', count: 2, observedTips: tips }, false)).toBe(
      'behind 2'
    )
    expect(
      formatReplicaRelation(
        { kind: 'diverged', mergeBase: SHA_C, aheadCount: 4, behindCount: 5, observedTips: tips },
        false
      )
    ).toBe('diverged +4/-5')
    expect(formatReplicaRelation({ kind: 'unrelated', observedTips: tips }, false)).toBe(
      'unrelated'
    )
  })

  it('prints an unknown relation with its closed reason', () => {
    expect(formatReplicaRelation({ kind: 'unknown', reason: 'relay-too-old' }, false)).toBe(
      'unverified (relay-too-old)'
    )
  })
})

describe('formatReplicaCompare: equal tips that are not verified clean (D-02)', () => {
  const cases: [string, WorktreeFact, WorktreeFact][] = [
    ['dirty-local', dirty, clean],
    ['unread-remote', clean, unread],
    ['dirty-remote', clean, dirty]
  ]

  it.each(cases)(
    '%s prints unverified (worktree-not-verified-clean) and exits 1',
    (id, local, remote) => {
      const { text, exitCode } = formatReplicaCompare(ok(equalTipsView(id, local, remote)))
      expect(text).toBe(`${id}  ssh:gex44  unverified (worktree-not-verified-clean)`)
      expect(text).not.toMatch(/\bsame\b/)
      expect(exitCode).toBe(1)
    }
  )

  it('control: clean on both sides prints same and exits 0', () => {
    const { text, exitCode } = formatReplicaCompare(ok(equalTipsView('clean-clean', clean, clean)))
    expect(text).toBe('clean-clean  ssh:gex44  same')
    expect(exitCode).toBe(0)
  })

  it('survives a JSON round trip of the wire result', () => {
    const wire = JSON.parse(JSON.stringify(ok(equalTipsView('dirty-local', dirty, clean))))
    expect(formatReplicaCompare(wire).exitCode).toBe(1)
  })
})

describe('formatReplicaCompare: exit code', () => {
  const known: ReplicaPairView[] = [
    viewOf('a', { kind: 'ahead', count: 1, observedTips: [SHA_A, SHA_B] }, false),
    viewOf(
      'b',
      {
        kind: 'diverged',
        mergeBase: SHA_C,
        aheadCount: 1,
        behindCount: 2,
        observedTips: [SHA_A, SHA_B]
      },
      false
    )
  ]

  it('is 0 when every pair is known, one line per pair', () => {
    const { text, exitCode } = formatReplicaCompare(ok(...known))
    expect(text.split('\n')).toEqual(['a  ssh:gex44  ahead 1', 'b  ssh:gex44  diverged +1/-2'])
    expect(exitCode).toBe(0)
  })

  it('is 1 when any one pair is unknown, and the known lines are still printed', () => {
    const unknown = viewOf('c', { kind: 'unknown', reason: 'host-unreachable' }, false)
    const { text, exitCode } = formatReplicaCompare(ok(...known, unknown))
    expect(text.split('\n')).toHaveLength(3)
    expect(text).toContain('c  ssh:gex44  unverified (host-unreachable)')
    expect(exitCode).toBe(1)
  })

  it('is 1 with an explanatory line when there is nothing to compare', () => {
    const { text, exitCode } = formatReplicaCompare(ok())
    expect(text).toContain('no other setups')
    expect(exitCode).toBe(1)
  })
})

describe('formatReplicaCompare: refusals, absences and not-found', () => {
  it('names the reason word for each and exits 1', () => {
    const results: [ReplicaPairCompareResult, RegExp][] = [
      [{ status: 'refused', reason: 'remote-caller' }, /refused \(remote-caller\)/],
      [{ status: 'unavailable', reason: 'no-replica-service' }, /no SSH relay session/],
      [{ status: 'not-found', reason: 'unknown-project' }, /unknown-project/],
      [{ status: 'not-found', reason: 'unknown-setup' }, /unknown-setup/]
    ]
    for (const [result, pattern] of results) {
      const { text, exitCode } = formatReplicaCompare(result)
      expect(text).toMatch(pattern)
      expect(exitCode).toBe(1)
    }
  })

  it('keeps the unavailable text pointing at the desktop runtime', () => {
    const { text } = formatReplicaCompare({ status: 'unavailable', reason: 'no-replica-service' })
    expect(text).toContain("desktop app's runtime")
  })
})
