import { z } from 'zod'
import { normalizeExecutionHostId } from '../../../../shared/execution-host'
import { publishedRelationsOf } from '../../../../shared/replica-pair-view'
import type { ReplicaRelation } from '../../../../shared/workspace-replica-state'
import { readReplicaPairService } from '../../../replica-pair-service-slot'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import { projectRepoResultVisibilityForClient } from '../repo-visibility-projection'
import {
  projectResultForClient,
  projectRootIdentityForClient,
  supportsProjectRootIdentity
} from '../project-root-identity-client-projection'

/** Only a capable client sees relations; an empty slot (headless serve) or a failed read publishes none. */
async function publishedSetupRelations(
  context: Pick<RpcContext, 'clientCapabilities'>
): Promise<ReadonlyMap<string, ReplicaRelation> | undefined> {
  const service = supportsProjectRootIdentity(context) ? readReplicaPairService() : null
  if (!service) {
    return undefined
  }
  try {
    return publishedRelationsOf((await service.relations()).pairs)
  } catch {
    // Why: no feed reads as plain unverified, which is never healthy; a git failure must not fail the list.
    return undefined
  }
}

const ProjectProviderIdentity = z.object({
  provider: z.literal('github'),
  owner: requiredString('Missing project owner'),
  repo: requiredString('Missing project repository'),
  host: OptionalString
})

const ProjectHostSetupExistingFolder = z.object({
  projectId: requiredString('Missing project ID'),
  projectProviderIdentity: ProjectProviderIdentity.optional(),
  hostId: requiredString('Missing host ID').transform((value, ctx) => {
    const hostId = normalizeExecutionHostId(value)
    if (!hostId) {
      ctx.addIssue({ code: 'custom', message: 'Invalid host ID' })
      return z.NEVER
    }
    return hostId
  }),
  path: requiredString('Missing project path'),
  kind: z.enum(['git', 'folder']).optional(),
  displayName: OptionalString,
  setupMethod: z.enum(['imported-existing-folder', 'cloned']).optional()
})

const ProjectHostSetupClone = z.object({
  projectId: requiredString('Missing project ID'),
  projectProviderIdentity: ProjectProviderIdentity.optional(),
  hostId: requiredString('Missing host ID').transform((value, ctx) => {
    const hostId = normalizeExecutionHostId(value)
    if (!hostId) {
      ctx.addIssue({ code: 'custom', message: 'Invalid host ID' })
      return z.NEVER
    }
    return hostId
  }),
  url: requiredString('Missing clone URL'),
  destination: requiredString('Missing clone destination'),
  displayName: OptionalString
})

const LocalWindowsRuntimePreference = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inherit-global') }),
  z.object({ kind: z.literal('windows-host') }),
  z.object({ kind: z.literal('wsl'), distro: requiredString('Missing WSL distro') })
])

const ProjectUpdate = z.object({
  projectId: requiredString('Missing project ID'),
  updates: z.object({
    localWindowsRuntimePreference: LocalWindowsRuntimePreference.optional()
  })
})

const ProjectHostSetupCreate = z.object({
  projectId: requiredString('Missing project ID'),
  hostId: requiredString('Missing host ID').transform((value, ctx) => {
    const hostId = normalizeExecutionHostId(value)
    if (!hostId) {
      ctx.addIssue({ code: 'custom', message: 'Invalid host ID' })
      return z.NEVER
    }
    return hostId
  }),
  setupId: OptionalString,
  path: OptionalString,
  kind: z.enum(['git', 'folder']).optional(),
  displayName: OptionalString,
  worktreeBasePath: OptionalString,
  gitUsername: OptionalString,
  setupState: z.enum(['ready', 'not-set-up', 'setting-up', 'error', 'unsupported']).optional(),
  setupMethod: z.enum(['imported-existing-folder', 'cloned', 'provisioned']).optional()
})

const ProjectHostSetupUpdate = z.object({
  setupId: requiredString('Missing setup ID'),
  updates: z.object({
    displayName: OptionalString,
    path: OptionalString,
    worktreeBasePath: OptionalString,
    setupState: z.enum(['ready', 'not-set-up', 'setting-up', 'error', 'unsupported']).optional(),
    setupMethod: z
      .enum(['legacy-repo', 'imported-existing-folder', 'cloned', 'provisioned'])
      .optional(),
    gitUsername: OptionalString,
    kind: z.enum(['git', 'folder']).optional()
  })
})

const ProjectHostSetupDelete = z.object({
  setupId: requiredString('Missing setup ID')
})

export const PROJECT_RUNTIME_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'project.list',
    params: null,
    handler: (_params, context) => {
      context.runtime.enrichMissingRepoGitRemoteIdentities?.()
      return projectRootIdentityForClient('projects', context.runtime.listProjects(), context)
    }
  }),
  defineMethod({
    name: 'project.update',
    params: ProjectUpdate,
    handler: (params, context) =>
      projectResultForClient(
        { project: context.runtime.updateProject(params.projectId, params.updates) },
        context
      )
  }),
  defineMethod({
    name: 'projectHostSetup.list',
    params: null,
    handler: async (_params, context) => {
      context.runtime.enrichMissingRepoGitRemoteIdentities?.()
      const relations = await publishedSetupRelations(context)
      return projectRootIdentityForClient(
        'setups',
        context.runtime.listProjectHostSetups(),
        context,
        relations
      )
    }
  }),
  defineMethod({
    name: 'projectHostSetup.create',
    params: ProjectHostSetupCreate,
    handler: (params, context) => ({
      result: projectResultForClient(context.runtime.createProjectHostSetup(params), context)
    })
  }),
  defineMethod({
    name: 'projectHostSetup.setupExistingFolder',
    params: ProjectHostSetupExistingFolder,
    handler: async (params, context) => ({
      result: projectResultForClient(
        projectRepoResultVisibilityForClient(
          await context.runtime.setupProjectExistingFolder(params),
          context
        ),
        context
      )
    })
  }),
  defineMethod({
    name: 'projectHostSetup.clone',
    params: ProjectHostSetupClone,
    handler: async (params, context) => ({
      result: projectResultForClient(
        projectRepoResultVisibilityForClient(
          await context.runtime.setupProjectClone(params),
          context
        ),
        context
      )
    })
  }),
  defineMethod({
    name: 'projectHostSetup.update',
    params: ProjectHostSetupUpdate,
    handler: (params, context) => ({
      result: projectResultForClient(
        projectRepoResultVisibilityForClient(
          context.runtime.updateProjectHostSetup(params),
          context
        ),
        context
      )
    })
  }),
  defineMethod({
    name: 'projectHostSetup.delete',
    params: ProjectHostSetupDelete,
    handler: (params, context) => ({
      result: projectResultForClient(
        projectRepoResultVisibilityForClient(
          context.runtime.deleteProjectHostSetup(params),
          context
        ),
        context
      )
    })
  })
]
