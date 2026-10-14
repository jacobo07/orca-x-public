import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
import { decideReplicaAncestry, receiveReplicaBundle } from '../../src/main/replica-bundle-receive'
import { divergenceRefs, preserveDivergence } from '../../src/main/replica-divergence'

/**
 * REAL-TWO-HOST rung for phase 19 (row 66): the p19 replica on GEX44 (seed-p19) rewrote seed.txt after the shared
 * seed commit. The laptop side makes its own conflicting rewrite, receives the GEX44 bundle over real SSH, and the
 * divergence workflow must preserve both tips as refs, surface seed.txt as conflicted, and leave both branches put.
 * Opt-in: a skip means NOT RUN.
 */

test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' || !process.env.ORCA_HWF_RUN_FILE || !process.env.ORCA_HWF_P19_PATH,
  'needs ORCA_HWF_TWO_HOST=1, ORCA_HWF_RUN_FILE and ORCA_HWF_P19_PATH (P19_REPLICA_PATH from seed-p19); a skip is NOT RUN'
)

test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: { ORCA_RELAY_PATH: path.join(process.cwd(), 'out', 'relay') }
})

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'hwf19',
  GIT_AUTHOR_EMAIL: 'hwf19@example.invalid',
  GIT_COMMITTER_NAME: 'hwf19',
  GIT_COMMITTER_EMAIL: 'hwf19@example.invalid'
}
const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], { cwd, env: ENV, encoding: 'utf8' }).trim()

test('diverged p19 replica from GEX44 is preserved as refs and its conflict surfaced; neither side moves', async ({
  orcaPage
}) => {
  test.setTimeout(900_000)
  const run = asReplicaRun(readHwfRunFile())
  const p19 = process.env.ORCA_HWF_P19_PATH as string
  expect(p19.startsWith('/tmp/orca-hwf-p17-')).toBe(true)
  await waitForSessionReady(orcaPage)
  const carrier = await startHwfCarrier(run, readHwfLocalPort())
  let targetId: string | null = null
  const scratch = mkdtempSync(path.join(tmpdir(), 'orca-hwf19-'))
  try {
    const connected = await connectHwfTargetWithTrust(orcaPage, run, readHwfLocalPort())
    targetId = connected.targetId
    expect(connected.pin).toBe(run.fingerprint)

    const remoteTip = execOnOwningHost(run, `git -C ${p19} rev-parse HEAD`).out.trim()
    expect(remoteTip).toMatch(/^[0-9a-f]{40}$/)
    // Bundle crosses the real SSH channel as base64 text; the same bytes are verified before any fetch.
    const b64 = execOnOwningHost(
      run,
      `git -C ${p19} bundle create - HEAD 2>/dev/null | base64 -w0`
    ).out.trim()
    const bundlePath = path.join(scratch, 'p19.bundle')
    writeFileSync(bundlePath, Buffer.from(b64, 'base64'))

    const repo = path.join(scratch, 'laptop')
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    // Local side: the shared seed commit (parent of the remote tip), then a conflicting rewrite of seed.txt.
    git(repo, 'fetch', '-q', bundlePath, 'HEAD')
    git(repo, 'reset', '-q', '--hard', `${remoteTip}~1`)
    writeFileSync(path.join(repo, 'seed.txt'), 'laptop side\n')
    git(repo, 'commit', '-qam', 'hwf p19 laptop rewrite')
    const localTip = git(repo, 'rev-parse', 'HEAD')

    const received = await receiveReplicaBundle({
      repoPath: repo,
      bundlePath,
      declaredHeads: [{ ref: 'HEAD', sha: remoteTip }],
      hostKey: 'gex44'
    })
    expect(received.ok).toBe(true)
    const ancestry = await decideReplicaAncestry(repo, localTip, remoteTip)
    expect('unknown' in ancestry).toBe(false)
    if ('unknown' in ancestry) {
      return
    }
    const res = await preserveDivergence({ repoPath: repo, hostKey: 'gex44', localTip, remoteTip, ancestry })
    const refs = divergenceRefs('gex44', localTip, remoteTip)
    console.log(`HWF19_ANCESTRY=${ancestry.kind}`)
    console.log(`HWF19_CONFLICT=${res.ok ? JSON.stringify(res.conflict) : res.reason}`)
    console.log(`HWF19_REFS=${git(repo, 'rev-parse', refs.local) === localTip && git(repo, 'rev-parse', refs.remote) === remoteTip}`)
    expect(ancestry.kind).toBe('diverged')
    expect(res).toMatchObject({ ok: true, conflict: { kind: 'conflicted', paths: ['seed.txt'] } })
    expect(git(repo, 'rev-parse', 'main')).toBe(localTip)
    expect(execOnOwningHost(run, `git -C ${p19} rev-parse HEAD`).out.trim()).toBe(remoteTip)
    console.log('HWF19_NEITHER_OVERWRITTEN=true')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
    if (targetId) {
      await disconnectHwfTarget(orcaPage, targetId)
    }
    await carrier.kill()
  }
})
