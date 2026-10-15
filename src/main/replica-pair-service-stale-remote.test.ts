// WR-02: a stored 'same'/healthy answer is a remote observation. After the SSH session it was taken under is gone
// (reconnect, dropped link) it must publish as evidence-stale, never as a healthy match nobody has verified since.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { publishedReplicaRelation } from '../shared/workspace-replica-state'
import { commitFile, createPairRig, type PairRig } from './replica-pair-test-rig'
import type { ReplicaPairService } from './replica-pair-service'

let rig: PairRig
let svc: ReplicaPairService

beforeEach(async () => {
  rig = createPairRig()
  svc = rig.service()
  // The rig's clone starts at the anchor's commit: equal tips, clean remote worktree.
  await svc.compare({ projectId: 'p1' })
})
afterEach(() => rig.dispose())

const box = async () => (await svc.relations()).pairs.find((p) => p.setupId === 'box')!

describe('a stored remote observation is not republished once its session is gone (WR-02)', () => {
  it('control: under the same generation and a live connection the stored same stays healthy', async () => {
    const pair = await box()
    expect(pair.relation.kind).toBe('same')
    expect(pair.healthy).toBe(true)
    expect(publishedReplicaRelation(pair.relation, pair.healthy).kind).toBe('same')
  })

  it('a reconnect (new SSH generation) demotes same/healthy to evidence-stale', async () => {
    rig.state.generation = 2
    const pair = await box()
    expect(pair.relation).toEqual({ kind: 'unknown', reason: 'evidence-stale' })
    expect(pair.healthy).toBe(false)
    expect(publishedReplicaRelation(pair.relation, pair.healthy)).toEqual({
      kind: 'unknown',
      reason: 'evidence-stale'
    })
    expect(pair).not.toHaveProperty('remoteTip')
  })

  it('a dropped connection demotes same/healthy even at the same generation', async () => {
    rig.state.muxAvailable = false
    const pair = await box()
    expect(pair.relation).toEqual({ kind: 'unknown', reason: 'evidence-stale' })
    expect(pair.healthy).toBe(false)
  })

  it('a fresh compare after the reconnect restores healthy (the demotion is about age, not state)', async () => {
    rig.state.generation = 2
    expect((await box()).healthy).toBe(false)
    await svc.compare({ projectId: 'p1' })
    const pair = await box()
    expect(pair.relation.kind).toBe('same')
    expect(pair.healthy).toBe(true)
  })

  it('the local tip fence still wins: a moved anchor is evidence-stale with or without a reconnect', async () => {
    commitFile(rig.local, 'l.txt', 'l\n')
    expect((await box()).relation).toEqual({ kind: 'unknown', reason: 'evidence-stale' })
  })
})
