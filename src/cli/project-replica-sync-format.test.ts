import { describe, expect, it } from 'vitest'
import type {
  ReplicaPreserveDivergenceResult,
  ReplicaReconcileResult,
  ReplicaSyncResult
} from '../shared/replica-sync-view'
import {
  formatReplicaPreserveDivergence,
  formatReplicaReconcile,
  formatReplicaSync
} from './project-replica-sync-format'

const FROM = '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TO = '2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const CAPSULE = `refs/orca/capsules/${'3'.repeat(40)}`
const SETUP = 'setup-b'

const sync = (result: ReplicaSyncResult) => formatReplicaSync(result, SETUP)
const preserve = (result: ReplicaPreserveDivergenceResult) =>
  formatReplicaPreserveDivergence(result, SETUP)
const reconcile = (result: ReplicaReconcileResult, remoteCapsule = 'f'.repeat(40)) =>
  formatReplicaReconcile(result, SETUP, remoteCapsule)

describe('formatReplicaSync', () => {
  it('ok prints the short range and the capsule that holds the previous state, and exits 0', () => {
    expect(sync({ status: 'ok', from: FROM, to: TO, capsuleRef: CAPSULE })).toEqual({
      text: `synced 1111111..2222222; previous state saved as ${CAPSULE}`,
      exitCode: 0
    })
  })

  it('ok without a capsule says nothing was uncommitted, never an empty "saved as"', () => {
    const out = sync({ status: 'ok', from: FROM, to: TO })
    expect(out.exitCode).toBe(0)
    expect(out.text).toBe('synced 1111111..2222222; there was no uncommitted work to save')
  })

  it('disk full, lost connection, interrupted transfer, unsupported relay and stale generation are five different texts', () => {
    const texts = {
      diskFull: sync({
        status: 'failed',
        reason: 'compare-transfer-interrupted',
        cause: 'disk-full'
      }).text,
      disconnect: sync({ status: 'failed', reason: 'compare-transfer-interrupted' }).text,
      relay: sync({ status: 'failed', reason: 'compare-relay-unsupported' }).text,
      stale: sync({ status: 'failed', reason: 'stale-generation' }).text
    }
    expect(texts.diskFull).toBe('sync failed: the local disk is full; HEAD was not moved')
    expect(texts.disconnect.split('\n')[0]).toBe(
      'sync failed: the connection to the host was lost or its relay is unavailable; HEAD was not moved'
    )
    expect(texts.relay.split('\n')[0]).toBe(texts.disconnect.split('\n')[0])
    expect(texts.stale).toBe('sync failed: the connection changed during the sync; run it again')
    expect(new Set(Object.values(texts)).size).toBe(4)
  })

  it('every failure exits 1', () => {
    for (const result of [
      { status: 'failed', reason: 'compare-transfer-interrupted', cause: 'disk-full' },
      { status: 'failed', reason: 'compare-transfer-interrupted' },
      { status: 'failed', reason: 'compare-relay-unsupported' },
      { status: 'failed', reason: 'stale-generation' },
      { status: 'failed', reason: 'not-behind', observedAncestry: 'same' },
      { status: 'failed', reason: 'ff-failed' },
      { status: 'failed', reason: 'capsule-failed' },
      { status: 'failed', reason: 'stale-tip' }
    ] as ReplicaSyncResult[]) {
      expect(sync(result).exitCode, JSON.stringify(result)).toBe(1)
    }
    // Control: the one success is the only 0.
    expect(sync({ status: 'ok', from: FROM, to: TO }).exitCode).toBe(0)
  })

  it('not-behind names what the comparison found and is not a success', () => {
    const behindNot = sync({ status: 'failed', reason: 'not-behind', observedAncestry: 'diverged' })
    expect(behindNot).toEqual({ text: 'nothing to sync: the replica is diverged', exitCode: 1 })
    expect(sync({ status: 'failed', reason: 'not-behind', observedAncestry: 'same' }).text).toBe(
      'nothing to sync: the replica is same'
    )
    expect(sync({ status: 'failed', reason: 'not-behind' }).text).toBe(
      'nothing to sync: the replica is not behind'
    )
  })

  it('other failures print their reason and say HEAD was not moved; the capsule is named when one was saved', () => {
    expect(sync({ status: 'failed', reason: 'stale-tip' }).text).toBe(
      'sync failed: stale-tip; HEAD was not moved'
    )
    const withCapsule = sync({ status: 'failed', reason: 'capsule-failed', capsuleRef: CAPSULE })
    expect(withCapsule.text).toContain('sync failed: capsule-failed; HEAD was not moved')
    expect(withCapsule.text).toContain(`previous state saved as ${CAPSULE}`)
  })

  it('verify-failed and ff-failed never claim HEAD was untouched', () => {
    const verify = sync({ status: 'failed', reason: 'verify-failed', capsuleRef: CAPSULE })
    expect(verify.text).not.toContain('HEAD was not moved')
    expect(verify.text).toContain('verify-failed')
    expect(verify.text).toContain('git status')
    expect(sync({ status: 'failed', reason: 'ff-failed' }).text).toContain('git status')
  })

  it('refusals print their word; worktree-busy and remote-runtime-unsupported say more', () => {
    expect(sync({ status: 'refused', reason: 'remote-caller' })).toMatchObject({ exitCode: 1 })
    expect(sync({ status: 'refused', reason: 'remote-caller' }).text).toContain('remote-caller')
    const busy = sync({ status: 'refused', reason: 'worktree-busy' })
    expect(busy.text).toContain('worktree-busy')
    expect(busy.text).toContain('another replica operation')
    const remoteRuntime = sync({ status: 'refused', reason: 'remote-runtime-unsupported' })
    expect(remoteRuntime.text).toContain(SETUP)
    expect(remoteRuntime.text).toContain('SSH replicas of a local anchor')
    expect(new Set([busy.text, remoteRuntime.text]).size).toBe(2)
  })

  it('unavailable and not-found are failures with their own words', () => {
    expect(sync({ status: 'unavailable', reason: 'no-replica-service' })).toMatchObject({
      exitCode: 1
    })
    expect(sync({ status: 'not-found', reason: 'unknown-setup' }).text).toContain('unknown-setup')
    expect(sync({ status: 'not-found', reason: 'unknown-setup' }).exitCode).toBe(1)
  })

  it('throws on a result arm it does not know rather than printing nothing', () => {
    expect(() => sync({ status: 'surprise' } as never)).toThrow(/Unhandled replica result/)
  })
})

describe('formatReplicaPreserveDivergence', () => {
  const refs = { local: 'refs/orca/divergence/local-1', remote: 'refs/orca/divergence/remote-1' }
  const base = { status: 'ok' as const, refs, mergeBase: FROM, alreadyPreserved: false }

  it('prints both refs, the merge base and conflict: none for a clean merge', () => {
    const out = preserve({ ...base, conflict: { kind: 'clean' } })
    expect(out.exitCode).toBe(0)
    expect(out.text).toContain(refs.local)
    expect(out.text).toContain(refs.remote)
    expect(out.text).toContain('merge base 1111111')
    expect(out.text).toContain('conflict: none')
  })

  it('a conflicted merge prints the count and every path, and still exits 0 (the divergence is preserved)', () => {
    const out = preserve({ ...base, conflict: { kind: 'conflicted', paths: ['a.ts', 'b/c.ts'] } })
    expect(out.exitCode).toBe(0)
    expect(out.text).toContain('conflict: 2 paths')
    expect(out.text).toContain('a.ts')
    expect(out.text).toContain('b/c.ts')
    expect(out.text).not.toContain('conflict: none')
    expect(preserve({ ...base, conflict: { kind: 'conflicted', paths: ['x'] } }).text).toContain(
      'conflict: 1 path\n'
    )
  })

  it('an unknown conflict is never printed as none', () => {
    const out = preserve({ ...base, conflict: { kind: 'unknown', reason: 'merge-tree-failed' } })
    expect(out.text).toContain('conflict: could not be determined (merge-tree-failed)')
    expect(out.text).not.toContain('none')
    expect(out.exitCode).toBe(0)
  })

  it('already preserved is said, and absent otherwise', () => {
    expect(
      preserve({ ...base, alreadyPreserved: true, conflict: { kind: 'clean' } }).text
    ).toContain('already preserved')
    expect(preserve({ ...base, conflict: { kind: 'clean' } }).text).not.toContain(
      'already preserved'
    )
  })

  it('not-diverged names the relation it found; ref-occupied has its own sentence; both exit 1', () => {
    const notDiverged = preserve({ status: 'refused', reason: 'not-diverged', relation: 'behind' })
    expect(notDiverged).toEqual({ text: 'the pair is not diverged (behind)', exitCode: 1 })
    const occupied = preserve({ status: 'refused', reason: 'ref-occupied' })
    expect(occupied.exitCode).toBe(1)
    expect(occupied.text).toContain('ref-occupied')
    expect(occupied.text).toContain('already points elsewhere')
    expect(occupied.text).not.toBe(notDiverged.text)
  })

  it('failures exit 1 and a full disk reads differently from a lost connection', () => {
    const full = preserve({
      status: 'failed',
      reason: 'compare-transfer-interrupted',
      cause: 'disk-full'
    })
    const lost = preserve({ status: 'failed', reason: 'compare-transfer-interrupted' })
    expect(full.exitCode).toBe(1)
    expect(lost.exitCode).toBe(1)
    expect(full.text).toContain('disk is full')
    expect(lost.text).toContain('connection')
    expect(full.text).not.toBe(lost.text)
    expect(preserve({ status: 'failed', reason: 'tip-missing' }).text).toContain('tip-missing')
  })

  it('refusals, unavailable and not-found exit 1', () => {
    for (const result of [
      { status: 'refused', reason: 'remote-caller' },
      { status: 'refused', reason: 'worktree-busy' },
      { status: 'unavailable', reason: 'no-replica-service' },
      { status: 'not-found', reason: 'unknown-setup' }
    ] as ReplicaPreserveDivergenceResult[]) {
      expect(preserve(result).exitCode, JSON.stringify(result)).toBe(1)
    }
  })

  it('throws on an unknown arm', () => {
    expect(() => preserve({ status: 'surprise' } as never)).toThrow(/Unhandled replica result/)
  })
})

describe('formatReplicaReconcile', () => {
  const COMMIT = '4444444cccccccccccccccccccccccccccccccc'
  const ok: Extract<ReplicaReconcileResult, { status: 'ok' }> = {
    status: 'ok',
    base: FROM,
    tree: 'e'.repeat(40),
    commit: COMMIT,
    ref: 'refs/orca/reconciled/aaaaaaaaaaaa-bbbbbbbbbbbb',
    localCapsuleRef: CAPSULE,
    localOmissions: [],
    untrackedNotReconciled: false
  }

  it('ok says the commit exists only under the ref and that HEAD and the working tree were not changed', () => {
    expect(reconcile(ok)).toEqual({
      text: `reconciled 4444444 at ${ok.ref}; HEAD and the working tree were not changed`,
      exitCode: 0
    })
  })

  it('ok surfaces omitted local paths and untracked files that were not reconciled', () => {
    const out = reconcile({
      ...ok,
      localOmissions: [
        { path: 'big.bin', reason: 'too-large' },
        { path: 'x', reason: 'unreadable' }
      ] as never,
      untrackedNotReconciled: true
    })
    expect(out.exitCode).toBe(0)
    expect(out.text).toContain('2 local paths were not captured')
    expect(out.text).toContain('untracked files')
    const one = reconcile({
      ...ok,
      localOmissions: [{ path: 'big.bin', reason: 'too-large' }] as never
    })
    expect(one.text).toContain('1 local path was not captured')
    // Control: neither note when there is nothing to say.
    expect(reconcile(ok).text).not.toContain('not captured')
    expect(reconcile(ok).text).not.toContain('untracked')
  })

  it('unknown-commit tells the user to fetch the capsule and shows the short sha', () => {
    const out = reconcile({ status: 'refused', reason: 'unknown-commit' }, '9'.repeat(40))
    expect(out.exitCode).toBe(1)
    expect(out.text).toContain('the remote capsule 9999999 is not in this repository')
    expect(out.text).toContain('git fetch <remote> <capsule ref>')
  })

  it('local-clean points at replica-sync', () => {
    const out = reconcile({ status: 'refused', reason: 'local-clean' })
    expect(out).toEqual({
      text: 'the local worktree has no changes; use replica-sync instead',
      exitCode: 1
    })
  })

  it('merge-tree-unsupported says Git is too old', () => {
    const out = reconcile({ status: 'refused', reason: 'merge-tree-unsupported' })
    expect(out.text).toBe('this Git is too old for merge-tree --write-tree; update Git')
    expect(out.exitCode).toBe(1)
  })

  it('a conflict prints the base and the sorted conflicted paths and is never a success', () => {
    const out = reconcile({
      status: 'failed',
      reason: 'conflict',
      base: FROM,
      conflictedPaths: ['z.ts', 'a.ts']
    })
    expect(out.exitCode).toBe(1)
    expect(out.text).toContain('base 1111111')
    expect(out.text.indexOf('a.ts')).toBeGreaterThan(-1)
    expect(out.text.indexOf('a.ts')).toBeLessThan(out.text.indexOf('z.ts'))
  })

  it('every other refusal and failure has its own sentence, all different, all exit 1', () => {
    const results = [
      { status: 'refused', reason: 'not-same-base' },
      { status: 'refused', reason: 'invalid-input' },
      { status: 'refused', reason: 'capsule-unmerged' },
      { status: 'refused', reason: 'capsule-unstable' },
      { status: 'refused', reason: 'worktree-busy' },
      { status: 'refused', reason: 'remote-runtime-unsupported' },
      { status: 'refused', reason: 'unknown-commit' },
      { status: 'refused', reason: 'local-clean' },
      { status: 'refused', reason: 'merge-tree-unsupported' },
      { status: 'failed', reason: 'commit-failed' },
      { status: 'failed', reason: 'conflict', base: FROM, conflictedPaths: ['a'] },
      { status: 'unavailable', reason: 'no-replica-service' },
      { status: 'not-found', reason: 'unknown-setup' }
    ] as ReplicaReconcileResult[]
    const texts = results.map((result) => {
      const out = reconcile(result)
      expect(out.exitCode, JSON.stringify(result)).toBe(1)
      return out.text
    })
    expect(new Set(texts).size).toBe(results.length)
  })

  it('throws on an unknown arm', () => {
    expect(() => reconcile({ status: 'surprise' } as never)).toThrow(/Unhandled replica result/)
  })
})
