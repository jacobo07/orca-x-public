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
import {
  formatReplicaCapsuleCreate,
  formatReplicaCapsuleList,
  formatReplicaCapsuleRestore,
  formatReplicaCompare,
  formatReplicaRelation
} from './project-replica-format'

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

describe('capsule formatters', () => {
  const REF = `refs/orca/capsules/${'d'.repeat(40)}`
  const base = 'b'.repeat(40)
  const created = (extra: { alreadyExisted?: boolean; omitted?: number }) =>
    formatReplicaCapsuleCreate(
      {
        status: 'ok',
        outcome: {
          kind: 'created',
          ref: REF,
          sha: 'd'.repeat(40),
          base,
          alreadyExisted: extra.alreadyExisted ?? false,
          omissions: Array.from({ length: extra.omitted ?? 0 }, (_, i) => ({
            path: `f${i}`,
            reason: 'unreadable'
          })) as never,
          partial: (extra.omitted ?? 0) > 0
        }
      },
      's'
    )

  it('create: created prints the ref and base; already existed and partial add lines; exit 0', () => {
    expect(created({})).toEqual({ text: `created ${REF} (base bbbbbbb)`, exitCode: 0 })
    const more = created({ alreadyExisted: true, omitted: 2 })
    expect(more.text).toContain('already existed')
    expect(more.text).toContain('partial: 2 paths omitted')
    expect(more.exitCode).toBe(0)
  })

  it('create: clean prints nothing-to-capture and exits 0; every other status exits 1', () => {
    expect(formatReplicaCapsuleCreate({ status: 'ok', outcome: { kind: 'clean' } }, 's')).toEqual({
      text: 'nothing to capture: the worktree is clean',
      exitCode: 0
    })
    for (const result of [
      { status: 'refused', reason: 'worktree-busy' },
      { status: 'unavailable', reason: 'no-replica-service' },
      { status: 'not-found', reason: 'unknown-setup' }
    ] as const) {
      expect(formatReplicaCapsuleCreate(result, 's').exitCode).toBe(1)
    }
  })

  it('create: a remote setup names the local-setup requirement and the setup', () => {
    const { text } = formatReplicaCapsuleCreate(
      { status: 'refused', reason: 'remote-capsule-unsupported' },
      'gex44'
    )
    expect(text).toContain('local setup')
    expect(text).toContain('gex44')
  })

  it('list: one line per capsule, damaged lines exit 1, control: none damaged exits 0', () => {
    const good = { ref: REF, sha: 'd'.repeat(40), baseTip: base, partial: true }
    const okOnly = formatReplicaCapsuleList({ status: 'ok', capsules: [good] }, 's')
    expect(okOnly.text).toContain(REF)
    expect(okOnly.exitCode).toBe(0)
    const withBad = formatReplicaCapsuleList(
      {
        status: 'ok',
        capsules: [good, { ref: 'refs/orca/capsules/x', damaged: true, reason: 'r' }]
      },
      's'
    )
    expect(withBad.text.split('\n')).toHaveLength(2)
    expect(withBad.text).toContain('damaged refs/orca/capsules/x (r)')
    expect(withBad.exitCode).toBe(1)
  })

  it('restore: plan prints three counts and the hint, applied prints applied; both exit 0', () => {
    const description = {
      ref: REF,
      sha: 'd'.repeat(40),
      base,
      partial: false,
      changes: { tracked: 2, staged: 1, untracked: 3 }
    }
    const plan = formatReplicaCapsuleRestore(
      { status: 'ok', outcome: { kind: 'plan', ...description } },
      's'
    )
    expect(plan.text).toContain('tracked 2')
    expect(plan.text).toContain('staged 1')
    expect(plan.text).toContain('untracked 3')
    expect(plan.text).toContain('plan only; re-run with --apply to change the worktree')
    expect(plan.exitCode).toBe(0)
    const applied = formatReplicaCapsuleRestore(
      {
        status: 'ok',
        outcome: {
          kind: 'applied',
          ...description,
          verified: { worktree: 't', index: 'i', untracked: null },
          warnings: ['w1']
        }
      },
      's'
    )
    expect(applied.text).toContain('applied')
    expect(applied.text).not.toContain('plan only')
    expect(applied.text).toContain('w1')
    expect(applied.exitCode).toBe(0)
  })

  it('restore: refused and failed exit 1; failed prints the recovery verbatim', () => {
    const refused = formatReplicaCapsuleRestore(
      { status: 'refused', reason: 'untracked-collision', detail: 'a.txt exists' },
      's'
    )
    expect(refused.text).toContain('untracked-collision')
    expect(refused.text).toContain('a.txt exists')
    expect(refused.exitCode).toBe(1)
    const failed = formatReplicaCapsuleRestore(
      {
        status: 'failed',
        reason: 'verify-failed',
        ref: REF,
        detail: 'd',
        recovery: 'R E C O V E R'
      },
      's'
    )
    expect(failed.text).toContain('R E C O V E R')
    expect(failed.text).toContain('verify-failed')
    expect(failed.exitCode).toBe(1)
  })
})
