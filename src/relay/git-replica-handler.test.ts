import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitReplicaHandler } from './git-replica-handler'
import { createMockDispatcher, type RelayDispatcher } from './git-handler-test-setup'

const g = (cwd: string, ...a: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd }).toString()

describe('GitReplicaHandler', () => {
  let repo: string
  let d: ReturnType<typeof createMockDispatcher>
  let h: GitReplicaHandler
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'replica-relay-'))
    g(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a'), 'a')
    g(repo, 'add', '.')
    g(repo, 'commit', '-qm', 'one')
    d = createMockDispatcher()
    h = new GitReplicaHandler(d as unknown as RelayDispatcher)
  })
  afterEach(async () => {
    await h.dispose()
    rmSync(repo, { recursive: true, force: true })
  })

  it('lists tips', async () => {
    const r = (await d.callRequest('git.replicaTips', { repoPath: repo })) as {
      heads: { ref: string; sha: string }[]
    }
    const sha = g(repo, 'rev-parse', 'HEAD').trim()
    expect(r.heads).toEqual([
      { ref: 'HEAD', sha },
      { ref: 'refs/heads/main', sha }
    ])
  })

  it('exports, streams sha256-matching chunks, verifies, and releases', async () => {
    const e = (await d.callRequest('git.replicaBundleExport', { repoPath: repo })) as {
      exportId: string
      size: number
      sha256: string
    }
    const parts: Buffer[] = []
    for (let off = 0; ; ) {
      const c = (await d.callRequest('git.replicaBundleRead', {
        exportId: e.exportId,
        offset: off,
        length: 7
      })) as { data: string; bytesRead: number; eof: boolean }
      parts.push(Buffer.from(c.data, 'base64'))
      off += c.bytesRead
      if (c.eof) {
        break
      }
    }
    const all = Buffer.concat(parts)
    expect(all.length).toBe(e.size)
    expect(createHash('sha256').update(all).digest('hex')).toBe(e.sha256)
    const out = join(mkdtempSync(join(tmpdir(), 'replica-out-')), 'x.bundle')
    writeFileSync(out, all)
    g(repo, 'bundle', 'verify', out)
    expect(await d.callRequest('git.replicaBundleRelease', { exportId: e.exportId })).toEqual({
      released: true
    })
    await expect(
      d.callRequest('git.replicaBundleRead', { exportId: e.exportId, offset: 0 })
    ).rejects.toThrow('unknown exportId')
  })

  it('rejects relative repoPath and bad offsets, caps concurrent exports', async () => {
    await expect(d.callRequest('git.replicaTips', { repoPath: 'rel' })).rejects.toThrow('absolute')
    const e = (await d.callRequest('git.replicaBundleExport', { repoPath: repo })) as {
      exportId: string
    }
    await expect(
      d.callRequest('git.replicaBundleRead', { exportId: e.exportId, offset: -1 })
    ).rejects.toThrow('invalid')
    await d.callRequest('git.replicaBundleExport', { repoPath: repo })
    await expect(d.callRequest('git.replicaBundleExport', { repoPath: repo })).rejects.toThrow(
      'too many'
    )
  })

  it('release removes the temp file', async () => {
    const e = (await d.callRequest('git.replicaBundleExport', { repoPath: repo })) as {
      exportId: string
    }
    const before = existsSync(tmpdir())
    expect(before).toBe(true)
    expect(await d.callRequest('git.replicaBundleRelease', { exportId: 'nope' })).toEqual({
      released: false
    })
    await d.callRequest('git.replicaBundleRelease', { exportId: e.exportId })
  })
})
