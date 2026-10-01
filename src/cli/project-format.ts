import type {
  Project,
  ProjectHostSetup,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupResult,
  ProjectHostSetupUpdateResult
} from '../shared/project-types'
import type { ProjectHostSetupWithReplicaTopology } from '../shared/replica-topology'
import {
  formatReplicaListRow,
  identityBasisOfProjectId,
  REPLICA_LIST_HEADER,
  replicaListFooter
} from './replica-topology-format'

export function formatProjectList(result: { projects: Project[] }): string {
  if (result.projects.length === 0) {
    return 'No projects found.'
  }
  return result.projects
    .map((project) => {
      const identity = project.providerIdentity
        ? `${project.providerIdentity.provider}:${project.providerIdentity.owner}/${project.providerIdentity.repo}`
        : 'no-provider'
      return `${project.id}  ${project.displayName}  ${identity}  basis:${identityBasisOfProjectId(project.id)}`
    })
    .join('\n')
}

export function formatProjectHostSetupList(
  result: { setups: ProjectHostSetupWithReplicaTopology[] },
  runtimeLabel?: string
): string {
  // Why: the scope footer is printed even when empty, so "no rows" never reads as "none anywhere".
  const footer = replicaListFooter(runtimeLabel)
  if (result.setups.length === 0) {
    return ['No project host setups found.', footer].join('\n')
  }
  return [REPLICA_LIST_HEADER, ...result.setups.map(formatReplicaListRow), footer].join('\n')
}

export function formatProjectHostSetupResult(result: { result: ProjectHostSetupResult }): string {
  const { project, setup, repo } = result.result
  return formatProjectHostSetupResultFields(project, setup, repo.id)
}

export function formatProjectHostSetupCreateResult(result: {
  result: ProjectHostSetupCreateResult
}): string {
  const { project, setup } = result.result
  return formatProjectHostSetupResultFields(project, setup, undefined)
}

export function formatProjectHostSetupUpdateResult(result: {
  result: ProjectHostSetupUpdateResult
}): string {
  const { project, setup, repo } = result.result
  return formatProjectHostSetupResultFields(project, setup, repo?.id)
}

export function formatProjectHostSetupDeleteResult(result: {
  result: ProjectHostSetupDeleteResult
}): string {
  const { project, setup, repo } = result.result
  return [
    `deleted: ${setup.id}`,
    formatProjectHostSetupResultFields(project, setup, repo?.id)
  ].join('\n')
}

function formatProjectHostSetupResultFields(
  project: Project,
  setup: ProjectHostSetup,
  repoId: string | undefined
): string {
  return [
    `projectId: ${project.id}`,
    `project: ${project.displayName}`,
    `setupId: ${setup.id}`,
    `hostId: ${setup.hostId}`,
    `path: ${setup.path}`,
    `state: ${setup.setupState}`,
    `method: ${setup.setupMethod}`,
    `repoId: ${repoId ?? 'none'}`
  ].join('\n')
}
