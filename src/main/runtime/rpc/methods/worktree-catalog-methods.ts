import { defineMethod, type RpcMethod } from '../core'
import { resolveWorktreeCatalogSnapshot } from '../worktree-catalog-snapshot'
import { worktreeResultForClient } from '../worktree-project-id-client-projection'
import { supportsWorktreeVisibilitySourceDefaults } from '../worktree-visibility-client-capability'
import {
  WorktreeDetectedListParams,
  WorktreeListParams,
  WorktreePsParams
} from './worktree-schemas'

export const WORKTREE_CATALOG_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'worktree.ps',
    params: WorktreePsParams,
    handler: async (params, context) => {
      const result = await context.runtime.getWorktreePs(
        params.limit,
        supportsWorktreeVisibilitySourceDefaults(
          context,
          params.supportsWorktreeVisibilitySourceDefaults
        )
      )
      // Why: callers that never send the field get the byte-exact legacy response.
      return params.afterSnapshotId === undefined
        ? result
        : resolveWorktreeCatalogSnapshot(result, params.afterSnapshotId)
    }
  }),
  defineMethod({
    name: 'worktree.list',
    params: WorktreeListParams,
    handler: async (params, context) =>
      worktreeResultForClient(
        await context.runtime.listManagedWorktrees(
          params.repo,
          params.limit,
          supportsWorktreeVisibilitySourceDefaults(context)
        ),
        context
      )
  }),
  defineMethod({
    name: 'worktree.listRetiredNames',
    params: WorktreeDetectedListParams,
    handler: async (params, { runtime }) => runtime.listRetiredWorktreeNames(params.repo)
  }),
  defineMethod({
    name: 'worktree.detectedList',
    params: WorktreeDetectedListParams,
    handler: async (params, context) =>
      worktreeResultForClient(
        await context.runtime.listDetectedManagedWorktrees(
          params.repo,
          undefined,
          supportsWorktreeVisibilitySourceDefaults(context)
        ),
        context
      )
  })
]
