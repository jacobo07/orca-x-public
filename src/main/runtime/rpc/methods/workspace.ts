import { z } from 'zod'
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from '../../../git/runner'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { readPlacements, type PlacementSubject } from '../../workspace-placement'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString } from '../schemas'

const PLACEMENT_LIMIT = 200
const PLACEMENT_READ_TIMEOUT_MS = 15_000
const PLACEMENT_DEADLINE_MS = 60_000
// Why: this runs about five git processes per worktree and observe-only clients may poll it.
const PLACEMENT_CACHE_MS = 5_000

const WorkspacePlacementsParams = z.object({ repo: OptionalString })

type PlacementReply = Awaited<ReturnType<typeof readPlacements>> & { truncated: boolean }
type Cached = { reply: Promise<PlacementReply>; atMs: number }

const cacheByRuntime = new WeakMap<OrcaRuntimeService, Map<string, Cached>>()

// Why: a read must not take index.lock and collide with the Owner's own git commit.
const git = async (args: string[], cwd: string): Promise<string> =>
  (
    await gitExecFileAsync(args, {
      cwd,
      timeout: PLACEMENT_READ_TIMEOUT_MS,
      env: gitOptionalLocksDisabledEnv()
    })
  ).stdout

async function isRemoteRepo(runtime: OrcaRuntimeService, repoId: string): Promise<boolean> {
  try {
    return Boolean((await runtime.showRepo(`id:${repoId}`)).connectionId)
  } catch {
    // Why remote: an unknown repo must be reported as unreadable, not read with whatever is at that path here.
    return true
  }
}

async function readAll(
  runtime: OrcaRuntimeService,
  repo: string | undefined
): Promise<PlacementReply> {
  const { worktrees, truncated } = await runtime.listManagedWorktrees(repo, PLACEMENT_LIMIT, false)
  const remoteByRepo = new Map<string, boolean>()
  const subjects: PlacementSubject[] = []
  for (const worktree of worktrees) {
    if (!remoteByRepo.has(worktree.repoId)) {
      remoteByRepo.set(worktree.repoId, await isRemoteRepo(runtime, worktree.repoId))
    }
    subjects.push({ ...worktree, remote: remoteByRepo.get(worktree.repoId) })
  }
  return { ...(await readPlacements(subjects, git, Date.now() + PLACEMENT_DEADLINE_MS)), truncated }
}

function cachedRead(
  runtime: OrcaRuntimeService,
  repo: string | undefined
): Promise<PlacementReply> {
  const cache = cacheByRuntime.get(runtime) ?? new Map<string, Cached>()
  cacheByRuntime.set(runtime, cache)
  const key = repo ?? ''
  const hit = cache.get(key)
  if (hit && Date.now() - hit.atMs < PLACEMENT_CACHE_MS) {
    return hit.reply
  }
  const reply = readAll(runtime, repo)
  cache.set(key, { reply, atMs: Date.now() })
  // Why: a failed read must not be replayed to the next caller.
  reply.catch(() => cache.delete(key))
  return reply
}

export const WORKSPACE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'workspace.placements',
    params: WorkspacePlacementsParams,
    handler: (params, { runtime }) => cachedRead(runtime, params.repo)
  })
]
