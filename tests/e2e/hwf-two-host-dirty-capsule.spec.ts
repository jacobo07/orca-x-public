import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from '@stablyai/playwright-test'

import { createCapsule } from '../../src/main/replica-capsule'
import { localCapsuleGit } from '../../src/main/replica-capsule-git'
import { execOnOwningHost, readHwfRunFile } from './helpers/hwf-two-host-ssh-target'

/**
 * REAL-TWO-HOST rung for phase 17 (row 64): the laptop captures a dirty worktree as a capsule commit and pushes the
 * ref over real SSH to a GEX44 disposable root, where an independent git reads the dirty content back.
 * Opt-in: a skip means NOT RUN. Run file: hwf-two-host-remote.mjs run-file (create + seed-p17-capsule already run).
 */
test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' || !process.env.ORCA_HWF_RUN_FILE,
  'needs ORCA_HWF_TWO_HOST=1 and ORCA_HWF_RUN_FILE (root minted with new-root --phase 17); a skip is NOT RUN'
)

const SEED_ENV = {
  GIT_AUTHOR_NAME: 'hwf16',
  GIT_AUTHOR_EMAIL: 'hwf16@example.invalid',
  GIT_AUTHOR_DATE: '2026-10-01T00:00:00+0000',
  GIT_COMMITTER_NAME: 'hwf16',
  GIT_COMMITTER_EMAIL: 'hwf16@example.invalid',
  GIT_COMMITTER_DATE: '2026-10-01T00:00:00+0000'
}
const SEED_FLAGS = [
  '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'commit.gpgsign=false',
  '-c', 'core.hooksPath=', '-c', 'init.defaultBranch=main', '-c', 'user.name=hwf16',
  '-c', 'user.email=hwf16@example.invalid'
]

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync('git', [...SEED_FLAGS, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${r.stdout}${r.stderr}`)
  }
  return r.stdout.trim()
}

function kv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line)
    if (m) {
      out[m[1]] = m[2]
    }
  }
  return out
}

test.describe('two-host dirty-state capsule', () => {
  test('a laptop capsule pushed over ssh reads back intact on the owning host', async () => {
    const run = readHwfRunFile()
    const nonce = run.seedNonce
    const target = `${run.root}/repos/p17-target`

    // Same seed on both hosts, so the capsule base is a commit the target already holds.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-hwf-p17-local-'))
    const repo = path.join(dir, 'p17-local')
    mkdirSync(repo)
    git(repo, ['init', '-q'], SEED_ENV)
    writeFileSync(path.join(repo, 'seed.txt'), `HWF17_${nonce}\n`)
    git(repo, ['add', 'seed.txt'], SEED_ENV)
    git(repo, ['commit', '-q', '-m', 'hwf p17 seed'], SEED_ENV)
    const seedHead = git(repo, ['rev-parse', 'HEAD'])
    // Dirty: tracked edit (W), staged new file (I), untracked file (U).
    writeFileSync(path.join(repo, 'seed.txt'), `HWF17_${nonce}\nworktree edit\n`)
    writeFileSync(path.join(repo, 'staged.txt'), `staged ${nonce}\n`)
    git(repo, ['add', 'staged.txt'])
    writeFileSync(path.join(repo, 'untracked.txt'), `untracked ${nonce}\n`)

    const before = git(repo, ['status', '--porcelain'])
    const created = await createCapsule(localCapsuleGit, repo)
    expect(created.kind).toBe('created')
    if (created.kind !== 'created') {
      return
    }
    expect(git(repo, ['status', '--porcelain'])).toBe(before)
    console.log(`P17_LOCAL_CAPSULE=${created.ref}`)

    const base = execOnOwningHost(run, `git -C '${target}' rev-parse HEAD`)
    expect(base.out.trim()).toBe(seedHead)

    const push = spawnSync(
      'git',
      ['push', '--quiet', `${run.carrierHost}:${target}`, `${created.ref}:${created.ref}`],
      { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } }
    )
    expect(push.status, `${push.stdout}${push.stderr}`).toBe(0)

    const verify = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'config', 'scripts', 'hwf-two-host-remote.mjs'),
        'verify-p17',
        run.root,
        nonce
      ],
      { encoding: 'utf8' }
    )
    const f = kv(`${verify.stdout}${verify.stderr}`)
    console.log(`${verify.stdout}`)
    expect(verify.status).toBe(0)
    expect(f.CAPSULE_REFS).toBe('1')
    expect(f.CAPSULE_REF).toBe(created.ref)
    expect(f.CAPSULE_REF_MATCHES_W).toBe('yes')
    expect(f.CAPSULE_FSCK).toBe('ok')
    expect(f.CAPSULE_PARENTS).toBe('3')
    expect(f.CAPSULE_BASE_IS_HEAD).toBe('yes')
    expect(f.CAPSULE_W_TRACKED).toContain(`HWF17_${nonce}`)
    expect(f.CAPSULE_I_STAGED).toBe(`staged ${nonce}`)
    expect(f.CAPSULE_U_UNTRACKED).toBe(`untracked ${nonce}`)
    expect(f.TARGET_STATUS_LINES).toBe('0')
    expect(f.TARGET_HEAD_UNCHANGED).toBe(seedHead)
    console.log(`P17_CAPSULE_READBACK=ok ref=${f.CAPSULE_REF}`)
  })
})
