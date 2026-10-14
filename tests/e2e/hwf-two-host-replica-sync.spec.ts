import { expect, test } from './helpers/orca-app'
import { asReplicaRun } from './helpers/hwf-two-host-replica-legs'
import { execOnOwningHost, readHwfRunFile } from './helpers/hwf-two-host-ssh-target'
import { fastForwardToDescendant, type GitRun } from '../../src/main/replica-sync'

/**
 * REAL-TWO-HOST rung for phase 18 (row 65): the sync pipeline runs from the laptop with every git call executed on
 * GEX44 over real SSH. A clone of the seed-p17 replica sits at its first commit (behind by 2); it must fast-forward
 * to the replica tip, capsule first, generation-fenced; a stale generation must stay a failure and not move HEAD.
 * Opt-in: a skip means NOT RUN.
 */
test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' || !process.env.ORCA_HWF_RUN_FILE || !process.env.ORCA_HWF_P17_PATH,
  'needs ORCA_HWF_TWO_HOST=1, ORCA_HWF_RUN_FILE and ORCA_HWF_P17_PATH (P17_REPLICA_PATH from seed-p17); a skip is NOT RUN'
)

test('fast-forward over SSH: capsule first, stale generation refused', async () => {
  test.setTimeout(300_000)
  const run = asReplicaRun(readHwfRunFile())
  const p17 = process.env.ORCA_HWF_P17_PATH as string
  expect(p17.startsWith('/tmp/orca-hwf-p17-')).toBe(true)
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  const remoteGit: GitRun = async (argv, opts) => {
    const env = opts.env?.GIT_INDEX_FILE ? `GIT_INDEX_FILE=${q(opts.env.GIT_INDEX_FILE)} ` : ''
    const r = execOnOwningHost(run, `cd ${q(opts.cwd)} && ${env}git ${argv.map(q).join(' ')}`)
    if (r.status !== 0) {
      throw new Error(r.out)
    }
    return { stdout: r.out }
  }
  const sh = (s: string): string => {
    const r = execOnOwningHost(run, s)
    expect(r.status).toBe(0)
    return r.out.trim()
  }
  const local = `${p17}-sync`
  expect(local.startsWith('/tmp/orca-hwf-p17-')).toBe(true)
  sh(`git clone -q ${q(p17)} ${q(local)} && git -C ${q(local)} reset -q --hard HEAD~2`)
  const behind = sh(`git -C ${q(local)} rev-parse HEAD`)
  const target = sh(`git -C ${q(p17)} rev-parse HEAD`)
  sh(`git -C ${q(local)} fetch -q origin`)
  const stale = await fastForwardToDescendant({
    repoPath: local, expectedLocalTip: behind, targetTip: target,
    evidenceGeneration: 1, currentGeneration: () => 2, git: remoteGit
  })
  console.log(`HWF18_STALE=${stale.ok ? 'ok' : stale.reason}`)
  expect(stale).toEqual({ ok: false, reason: 'stale-generation' })
  expect(sh(`git -C ${q(local)} rev-parse HEAD`)).toBe(behind)
  const res = await fastForwardToDescendant({
    repoPath: local, expectedLocalTip: behind, targetTip: target,
    evidenceGeneration: 1, currentGeneration: () => 1, git: remoteGit
  })
  console.log(`HWF18_FF=${res.ok ? 'ok' : res.reason}`)
  expect(res.ok).toBe(true)
  expect(sh(`git -C ${q(local)} rev-parse HEAD`)).toBe(target)
  if (res.ok) {
    console.log(`HWF18_CAPSULE=${res.capsuleRef.startsWith('refs/orca/capsules/') ? 'present' : 'missing'}`)
    sh(`git -C ${q(local)} rev-parse --verify ${q(res.capsuleRef)}`)
  }
})
