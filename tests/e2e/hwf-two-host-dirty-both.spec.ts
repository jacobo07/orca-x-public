import { expect, test } from './helpers/orca-app'
import { asReplicaRun } from './helpers/hwf-two-host-replica-legs'
import { execOnOwningHost, readHwfRunFile } from './helpers/hwf-two-host-ssh-target'
import { reconcileDirtyBoth } from '../../src/main/replica-reconcile'
import { createCapsule } from '../../src/main/replica-capsule'
import type { GitRun } from '../../src/main/replica-sync'
import { remoteCapsuleGit } from './helpers/hwf-two-host-remote-capsule-git'

/**
 * REAL-TWO-HOST rung for phase 19 (row 67): dirty-both reconciliation with every git call executed on GEX44 over
 * real SSH. Two clones of the seed-p17 replica are dirtied on the same base: disjoint edits must reconcile through a
 * clean merge-tree; same-line edits must come back as a conflict naming the path and write no reconciled ref.
 * Opt-in: a skip means NOT RUN.
 */
test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' || !process.env.ORCA_HWF_RUN_FILE || !process.env.ORCA_HWF_P17_PATH,
  'needs ORCA_HWF_TWO_HOST=1, ORCA_HWF_RUN_FILE and ORCA_HWF_P17_PATH (P17_REPLICA_PATH from seed-p17); a skip is NOT RUN'
)

test('dirty-both over SSH: disjoint edits reconcile, same-line edits conflict', async () => {
  test.setTimeout(300_000)
  const run = asReplicaRun(readHwfRunFile())
  const p17 = process.env.ORCA_HWF_P17_PATH as string
  expect(p17.startsWith('/tmp/orca-hwf-p17-')).toBe(true)
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  const remoteGit: GitRun = async (argv, opts) => {
    const env = opts.env?.GIT_INDEX_FILE ? `GIT_INDEX_FILE=${q(opts.env.GIT_INDEX_FILE)} ` : ''
    const r = execOnOwningHost(run, `cd ${q(opts.cwd)} && ${env}git ${argv.map(q).join(' ')}`)
    if (r.status !== 0) {
      throw Object.assign(new Error(r.out), { code: r.status, stdout: r.out })
    }
    return { stdout: r.out }
  }
  const capsuleGit = remoteCapsuleGit((script) => execOnOwningHost(run, script))
  const sh = (s: string): string => {
    const r = execOnOwningHost(run, s)
    expect(r.status).toBe(0)
    return r.out.trim()
  }
  const files = sh(`git -C ${q(p17)} ls-files`).split('\n').filter(Boolean)
  expect(files.length).toBeGreaterThan(1)
  const [shared, other] = files
  const base = sh(`git -C ${q(p17)} rev-parse HEAD`)

  const cutPair = async (tag: string, editA: string, editB: string): Promise<{ a: string; la: string; rb: string }> => {
    const a = `${p17}-${tag}a`
    const b = `${p17}-${tag}b`
    expect(a.startsWith('/tmp/orca-hwf-p17-') && b.startsWith('/tmp/orca-hwf-p17-')).toBe(true)
    sh(`git clone -q ${q(p17)} ${q(a)} && git clone -q ${q(p17)} ${q(b)}`)
    sh(`${editA.replace(/@R/g, q(a))} && ${editB.replace(/@R/g, q(b))}`)
    const ca = await createCapsule(capsuleGit, a)
    const cb = await createCapsule(capsuleGit, b)
    if (ca.kind !== 'created' || cb.kind !== 'created') {
      throw new Error(`capsule not created: ${ca.kind} ${cb.kind}`)
    }
    sh(`git -C ${q(a)} fetch -q ${q(b)} ${q(cb.ref)}`)
    return { a, la: ca.sha, rb: cb.sha }
  }

  // Tracked edits only: the capsule probes the index and untracked files on the calling host, not over SSH.
  const ok = await cutPair('d', `echo local > @R/${shared}`, `echo remote > @R/${other}`)
  const clean = await reconcileDirtyBoth({ repoPath: ok.a, localCapsule: ok.la, remoteCapsule: ok.rb, base, git: remoteGit })
  console.log(`HWF19_DISJOINT=${clean.ok ? 'reconciled' : clean.reason}`)
  expect(clean.ok).toBe(true)
  if (clean.ok) {
    expect(clean.untrackedNotReconciled).toBe(false)
    expect(sh(`git -C ${q(ok.a)} show ${q(`${clean.commit}:${shared}`)}`)).toBe('local')
    expect(sh(`git -C ${q(ok.a)} show ${q(`${clean.commit}:${other}`)}`)).toBe('remote')
  }

  const bad = await cutPair('c', `echo local > @R/${shared}`, `echo remote > @R/${shared}`)
  const conflict = await reconcileDirtyBoth({ repoPath: bad.a, localCapsule: bad.la, remoteCapsule: bad.rb, base, git: remoteGit })
  console.log(`HWF19_CONFLICT=${conflict.ok ? 'reconciled' : conflict.reason}`)
  expect(conflict).toEqual({ ok: false, reason: 'conflict', base, conflictedPaths: [shared] })
  console.log(`HWF19_NO_REF=${sh(`git -C ${q(bad.a)} for-each-ref refs/orca/reconciled`) === '' ? 'ok' : 'leaked'}`)
  expect(sh(`git -C ${q(bad.a)} for-each-ref refs/orca/reconciled`)).toBe('')
})
