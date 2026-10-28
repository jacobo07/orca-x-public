// Relay side of the replica comparison transport (row 63): list tips, export a bundle to a
// private temp file, stream it back in sha256-checked chunks, release it. `git.exec` is not
// widened: bundle/for-each-ref run here with fixed argv, never from client-supplied argv.
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { RelayDispatcher } from './dispatcher'
import { buildRelayGitEnv } from './relay-command-env'

const execFileAsync = promisify(execFile)

export const REPLICA_BUNDLE_RELAY_CAPABILITIES = ['git.replicaBundle'] as const
export const REPLICA_CHUNK_MAX_BYTES = 256 * 1024
export const REPLICA_BUNDLE_MAX_BYTES = 256 * 1024 * 1024
const MAX_EXPORTS = 2
const GIT_TIMEOUT_MS = 120_000
const SHA = /^[0-9a-f]{40,64}$/

type Head = { ref: string; sha: string }
type ExportEntry = { dir: string; file: string; size: number; sha256: string }

async function git(args: string[], cwd: string, maxBuffer = 16 * 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: buildRelayGitEnv(process.env),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer
  })
  return stdout
}

function requireRepoPath(p: unknown): string {
  if (typeof p !== 'string' || !isAbsolute(p)) {
    throw new Error('replica: repoPath must be an absolute path')
  }
  return p
}

async function listHeads(repo: string): Promise<Head[]> {
  const heads: Head[] = []
  const head = (await git(['rev-parse', '--verify', '-q', 'HEAD'], repo).catch(() => '')).trim()
  if (SHA.test(head)) {
    heads.push({ ref: 'HEAD', sha: head })
  }
  const out = await git(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads'], repo)
  for (const line of out.split('\n')) {
    const [sha, ref] = line.trim().split(' ')
    if (sha && ref && SHA.test(sha)) {
      heads.push({ ref, sha })
    }
  }
  return heads
}

export class GitReplicaHandler {
  private readonly exports = new Map<string, ExportEntry>()

  constructor(dispatcher: RelayDispatcher) {
    dispatcher.onRequest('git.replicaTips', async (p) => ({
      heads: await listHeads(requireRepoPath(p.repoPath))
    }))
    dispatcher.onRequest('git.replicaBundleExport', (p) => this.exportBundle(p))
    dispatcher.onRequest('git.replicaBundleRead', (p) => this.read(p))
    dispatcher.onRequest('git.replicaBundleRelease', (p) => this.release(p))
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.exports.keys()].map((id) => this.release({ exportId: id })))
  }

  private async exportBundle(p: Record<string, unknown>): Promise<unknown> {
    const repo = requireRepoPath(p.repoPath)
    if (this.exports.size >= MAX_EXPORTS) {
      throw new Error('replica: too many concurrent exports')
    }
    const heads = await listHeads(repo)
    if (heads.length === 0) {
      throw new Error('replica: nothing to export')
    }
    const refs = heads.map((h) => h.ref)
    const dir = await mkdtemp(join(tmpdir(), 'orca-replica-'))
    const file = join(dir, 'replica.bundle')
    try {
      await git(['bundle', 'create', file, ...refs], repo)
      const size = (await stat(file)).size
      if (size > REPLICA_BUNDLE_MAX_BYTES) {
        throw new Error('replica: bundle exceeds size cap')
      }
      const fh = await open(file, 'r')
      const hash = createHash('sha256')
      try {
        for await (const chunk of fh.createReadStream()) {
          hash.update(chunk as Buffer)
        }
      } finally {
        await fh.close()
      }
      const exportId = randomUUID()
      const sha256 = hash.digest('hex')
      this.exports.set(exportId, { dir, file, size, sha256 })
      return { exportId, size, sha256, heads }
    } catch (error) {
      await rm(dir, { recursive: true, force: true })
      throw error
    }
  }

  private async read(p: Record<string, unknown>): Promise<unknown> {
    const entry = this.exports.get(String(p.exportId))
    if (!entry) {
      throw new Error('replica: unknown exportId')
    }
    const offset = Number(p.offset)
    const length = Math.min(Number(p.length ?? REPLICA_CHUNK_MAX_BYTES), REPLICA_CHUNK_MAX_BYTES)
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length <= 0) {
      throw new Error('replica: invalid offset/length')
    }
    const fh = await open(entry.file, 'r')
    try {
      const buf = Buffer.alloc(Math.max(0, Math.min(length, entry.size - offset)))
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
      return {
        data: buf.subarray(0, bytesRead).toString('base64'),
        bytesRead,
        eof: offset + bytesRead >= entry.size
      }
    } finally {
      await fh.close()
    }
  }

  private async release(p: Record<string, unknown>): Promise<{ released: boolean }> {
    const id = String(p.exportId)
    const entry = this.exports.get(id)
    if (!entry) {
      return { released: false }
    }
    this.exports.delete(id)
    await rm(entry.dir, { recursive: true, force: true })
    return { released: true }
  }
}
