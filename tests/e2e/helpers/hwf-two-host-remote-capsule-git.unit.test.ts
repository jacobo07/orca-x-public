import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildRemoteCapsuleCommand,
  remoteCapsuleGit,
  type RemoteExec
} from './hwf-two-host-remote-capsule-git'

const localBash: RemoteExec = (script) => {
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

let root: string
let repo: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orca-remote-capsule-it's-"))
  repo = join(root, "repo with 'quote'")
  mkdirSync(repo)
  execFileSync('git', ['init', '-q', repo])
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('buildRemoteCapsuleCommand', () => {
  it('single-quotes every token so a path with a single quote survives', async () => {
    const git = remoteCapsuleGit(localBash)
    const top = await git(['rev-parse', '--show-toplevel'], { cwd: repo })
    expect(top.trim()).toBe(realpathSync(repo))
  })

  it('prefixes only allow-listed variables', () => {
    const command = buildRemoteCapsuleCommand({
      cwd: '/x',
      argv: ['status'],
      env: { GIT_INDEX_FILE: '/tmp/i', GIT_AUTHOR_NAME: 'a b' }
    })
    expect(command).toContain(`GIT_INDEX_FILE='/tmp/i' GIT_AUTHOR_NAME='a b' git 'status'`)
  })

  it.each(['PATH', 'LD_PRELOAD', 'GIT_DIR', 'GIT_INDEX_FILE; echo pwned', 'git_index_file', ''])(
    'rejects variable name %j',
    (name) => {
      expect(() =>
        buildRemoteCapsuleCommand({ cwd: '/x', argv: ['status'], env: { [name]: 'v' } })
      ).toThrow(/refusing remote environment variable/)
    }
  )

  it('carries stdin as base64: NUL and non-ASCII hash to the same object id as the bytes directly', async () => {
    const input = 'café ☃\0 tail\n\0'
    const direct = execFileSync('git', ['hash-object', '--stdin'], {
      cwd: repo,
      input: Buffer.from(input, 'utf8')
    })
      .toString()
      .trim()
    const viaRemote = (
      await remoteCapsuleGit(localBash)(['hash-object', '-w', '--stdin'], { cwd: repo, input })
    ).trim()
    expect(viaRemote).toBe(direct)
    // The -w write really landed in the repo's object store.
    expect(
      execFileSync('git', ['cat-file', '-t', viaRemote], { cwd: repo }).toString().trim()
    ).toBe('blob')
  })

  it('control: a different payload hashes differently', async () => {
    const git = remoteCapsuleGit(localBash)
    const a = await git(['hash-object', '--stdin'], { cwd: repo, input: 'a\0' })
    const b = await git(['hash-object', '--stdin'], { cwd: repo, input: 'a\0\0' })
    expect(a).not.toBe(b)
  })

  it('a failing git command rejects with its stderr and exit code', async () => {
    const git = remoteCapsuleGit(localBash)
    await expect(
      git(['rev-parse', '--verify', 'no-such-ref^{commit}'], { cwd: repo })
    ).rejects.toMatchObject({
      code: expect.any(Number),
      message: expect.stringContaining('fatal')
    })
  })

  it('a successful command that warns on stderr returns only the object id', async () => {
    const out = await remoteCapsuleGit(localBash)(
      ['-c', 'core.autocrlf=true', 'hash-object', '-w', '--path=x.txt', '--stdin'],
      { cwd: repo, input: 'a\r\nb\n' }
    )
    expect(out.trim()).toMatch(/^[0-9a-f]{40,64}$/)
    expect(out).not.toContain('warning')
  })
})
