import path from 'node:path'

import { expect, test } from './helpers/orca-app'
import { startHwfCarrier } from './helpers/hwf-two-host-carrier'
import { asReplicaRun } from './helpers/hwf-two-host-replica-legs'
import {
  connectHwfTargetWithTrust,
  disconnectHwfTarget,
  execOnOwningHost,
  readHwfLocalPort,
  readHwfRunFile
} from './helpers/hwf-two-host-ssh-target'
import { waitForSessionReady } from './helpers/store'
import {
  deriveReplicaRelation,
  isReplicaRelationHealthy,
  type ReplicaFacts
} from '../../src/shared/workspace-replica-state'

/**
 * REAL-TWO-HOST rung for phase 17 (row 62): facts and ancestry evidence are read from the GEX44 host over real
 * SSH and folded through the state model. The p17 replica (seed-p17) is two commits ahead of the seed root:
 * the model must say ahead 2, not healthy; an unreachable path must read unknown, never healthy.
 * Opt-in: a skip means NOT RUN.
 */

test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' || !process.env.ORCA_HWF_RUN_FILE || !process.env.ORCA_HWF_P17_PATH,
  'needs ORCA_HWF_TWO_HOST=1, ORCA_HWF_RUN_FILE and ORCA_HWF_P17_PATH (P17_REPLICA_PATH from seed-p17); a skip is NOT RUN'
)

test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: { ORCA_RELAY_PATH: path.join(process.cwd(), 'out', 'relay') }
})

test('state model decides ahead from evidence read over SSH; unreadable host is unknown', async ({ orcaPage }) => {
  test.setTimeout(900_000)
  const run = asReplicaRun(readHwfRunFile())
  const p17 = process.env.ORCA_HWF_P17_PATH as string
  expect(p17.startsWith('/tmp/orca-hwf-p17-')).toBe(true)
  await waitForSessionReady(orcaPage)
  const carrier = await startHwfCarrier(run, readHwfLocalPort())
  let targetId: string | null = null
  try {
    const connected = await connectHwfTargetWithTrust(orcaPage, run, readHwfLocalPort())
    targetId = connected.targetId
    expect(connected.pin).toBe(run.fingerprint)
    const rev = (repo: string, spec: string): string => {
      const r = execOnOwningHost(run, `git -C ${repo} rev-parse ${spec}`)
      return r.status === 0 ? r.out.trim() : ''
    }
    // seedRoot is a commit, not a repo: resolve it inside the replica on the owning host.
    const seedTip = rev(p17, `${run.seedRoot}^{commit}`)
    const replicaTip = rev(p17, 'HEAD')
    expect(seedTip).toMatch(/^[0-9a-f]{40}$/)
    expect(replicaTip).toMatch(/^[0-9a-f]{40}$/)
    const count = Number(execOnOwningHost(run, `git -C ${p17} rev-list --count ${run.seedRoot}..HEAD`).out.trim())
    const facts = (hostId: string, sha: string): ReplicaFacts => ({
      setupId: 'p17',
      hostId,
      tip: { kind: 'commit', sha, ref: 'HEAD' },
      worktree: { kind: 'clean' }
    })
    const seed = facts('seed', seedTip)
    const replica = facts('replica', replicaTip)
    const relation = deriveReplicaRelation(replica, seed, {
      observedTips: [replicaTip, seedTip],
      site: 'gex44',
      outcome: { ok: true, ancestry: { kind: 'ahead', count } }
    })
    console.log(`HWF17_STATE=${relation.kind}:${'count' in relation ? relation.count : ''}`)
    expect(relation).toMatchObject({ kind: 'ahead', count: 2 })
    expect(isReplicaRelationHealthy(relation, replica, seed)).toBe(false)
    const missing = rev('/tmp/orca-hwf-p17-does-not-exist', 'HEAD')
    expect(missing).toBe('')
    const unknownRel = deriveReplicaRelation(
      { ...replica, tip: { kind: 'unknown', reason: 'host-unreachable' } },
      seed
    )
    console.log(`HWF17_UNREADABLE=${unknownRel.kind}`)
    expect(unknownRel).toEqual({ kind: 'unknown', reason: 'host-unreachable' })
  } finally {
    if (targetId) {
      await disconnectHwfTarget(orcaPage, targetId)
    }
    await carrier.kill()
  }
})
