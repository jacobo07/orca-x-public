// Relay side of the remote worktree fact (row 74): one fixed-argv, read-only `git status` per request.
// Nothing but an absolute repoPath crosses from the client; no argv, ref or flag is accepted.
import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { REPLICA_FACTS_METHOD } from '../shared/replica-facts-wire'
import { worktreeFactFromPorcelain } from '../shared/replica-worktree-facts'
import type { WorktreeFact } from '../shared/workspace-replica-state'
import type { RelayDispatcher } from './dispatcher'
import { buildRelayGitEnv } from './relay-command-env'

const execFileAsync = promisify(execFile)

export const SYNC_RELAY_CAPABILITIES = ['sync.v1'] as const
const GIT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_STATUS_BYTES = 8 * 1024 * 1024
const STATUS_ARGV = ['status', '--porcelain=v1', '-z', '--untracked-files=all']

type ExecError = { code?: unknown; stderr?: unknown }

function requireRepoPath(p: unknown): string {
  if (typeof p !== 'string' || !isAbsolute(p)) {
    throw new Error('replica: repoPath must be an absolute path')
  }
  return p
}

function isNotARepository(error: ExecError): boolean {
  return typeof error.stderr === 'string' && /not a git repository/i.test(error.stderr)
}

async function readWorktreeFact(repo: string, maxBuffer: number): Promise<WorktreeFact> {
  try {
    const { stdout } = await execFileAsync('git', STATUS_ARGV, {
      cwd: repo,
      // Why: a stale index must not be refreshed on disk by a read that claims to be read-only.
      env: { ...buildRelayGitEnv(process.env), GIT_OPTIONAL_LOCKS: '0' },
      timeout: GIT_TIMEOUT_MS,
      maxBuffer
    })
    return worktreeFactFromPorcelain(stdout)
  } catch (error) {
    const failure = error as ExecError
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { kind: 'unknown', reason: 'status-output-too-large' }
    }
    if (isNotARepository(failure)) {
      return { kind: 'unknown', reason: 'not-a-git-repo' }
    }
    return { kind: 'unknown', reason: 'status-read-failed' }
  }
}

export class ReplicaFactsHandler {
  constructor(dispatcher: RelayDispatcher, options: { maxStatusBytes?: number } = {}) {
    const maxBuffer = options.maxStatusBytes ?? DEFAULT_MAX_STATUS_BYTES
    dispatcher.onRequest(REPLICA_FACTS_METHOD, async (p) => ({
      worktree: await readWorktreeFact(requireRepoPath(p.repoPath), maxBuffer)
    }))
  }
}
