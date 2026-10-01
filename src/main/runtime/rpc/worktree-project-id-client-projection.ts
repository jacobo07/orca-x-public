import {
  projectIdResolverForClient,
  supportsProjectRootIdentity
} from './project-root-identity-client-projection'
import type { RpcContext } from './core'

type WorktreeRecord = { repoId?: string; projectId?: string }

type ProjectionContext = Pick<RpcContext, 'clientCapabilities' | 'runtime'>

/**
 * A worktree carries the id of the project it belongs to, and that id can be a `git-root:` one. A
 * client without `projects.root-identity.v1` has only ever been given `repo:`/`git:`/`github:` ids
 * by the project publishers, so it is shown the id it was given for that repo, and a worktree whose
 * repo maps to none loses the field (it is optional) rather than carrying one the client cannot
 * resolve. Capable clients and in-process callers get the result unchanged, by reference.
 */
export function worktreeResultForClient<T extends object>(
  result: T,
  context: ProjectionContext
): T {
  if (supportsProjectRootIdentity(context)) {
    return result
  }
  const resolve = projectIdResolverForClient(context)
  const mapRecord = <R extends WorktreeRecord>(record: R): R => {
    if (!record.projectId) {
      return record
    }
    const projectId = resolve(record.projectId, record.repoId)
    if (projectId === record.projectId) {
      return record
    }
    const mapped = { ...record }
    if (projectId) {
      mapped.projectId = projectId
    } else {
      delete mapped.projectId
    }
    return mapped
  }
  const shape = result as { worktree?: WorktreeRecord; worktrees?: WorktreeRecord[] }
  const worktree = shape.worktree ? mapRecord(shape.worktree) : shape.worktree
  const worktrees = shape.worktrees?.map(mapRecord)
  const changed =
    worktree !== shape.worktree || worktrees?.some((entry, i) => entry !== shape.worktrees?.[i])
  return changed
    ? { ...result, ...(worktree ? { worktree } : {}), ...(worktrees ? { worktrees } : {}) }
    : result
}
