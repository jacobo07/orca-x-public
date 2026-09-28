import type { ExecutionHostHealth } from '../../../../shared/execution-host-registry'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'

/** `health` null: the host registry does not know this host, which says nothing about its state. */
export type AgentProjectHost = {
  id: ExecutionHostId
  label: string
  health: ExecutionHostHealth | null
  /** The repo that is this project's checkout on this host — what "open it here" opens. */
  repoId: string
}

export type AgentProjectChoice = {
  projectId: string
  displayName: string
  badgeColor: string
  /** Hosts with a ready setup, in first-seen order; empty when the project is set up nowhere yet. */
  hosts: AgentProjectHost[]
  /** A ready setup's path, so two projects with one name can be told apart. */
  path: string | null
  /** Another project carries the same display name. */
  sharesName: boolean
}

type HostLookup = ReadonlyMap<
  ExecutionHostId,
  { label: string; health: ExecutionHostHealth | null }
>

/**
 * One row per canonical Project — the same estate the Terminals view reads — never per repo or per
 * host: an agent binds to a Project, and a project set up on two hosts is still one choice.
 */
export function buildAgentProjectChoices(
  projects: readonly Project[],
  setups: readonly ProjectHostSetup[],
  hosts: HostLookup
): AgentProjectChoice[] {
  const nameCounts = new Map<string, number>()
  for (const project of projects) {
    const key = project.displayName.trim().toLowerCase()
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1)
  }
  return projects.map((project) => {
    const ready = setups.filter(
      (setup) => setup.projectId === project.id && setup.setupState === 'ready'
    )
    const seen = new Set<ExecutionHostId>()
    const projectHosts: AgentProjectHost[] = []
    for (const setup of ready) {
      if (seen.has(setup.hostId)) {
        continue
      }
      seen.add(setup.hostId)
      const known = hosts.get(setup.hostId)
      // An unknown host keeps its id rather than disappearing: a missing label is not a missing host.
      projectHosts.push({
        id: setup.hostId,
        label: known?.label ?? setup.hostId,
        health: known?.health ?? null,
        repoId: setup.repoId
      })
    }
    return {
      projectId: project.id,
      displayName: project.displayName,
      badgeColor: project.badgeColor,
      hosts: projectHosts,
      path: ready[0]?.path ?? null,
      sharesName: (nameCounts.get(project.displayName.trim().toLowerCase()) ?? 0) > 1
    }
  })
}

/** Case-insensitive match on name, path or host label. */
export function filterAgentProjectChoices(
  choices: readonly AgentProjectChoice[],
  query: string
): readonly AgentProjectChoice[] {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return choices
  }
  return choices.filter(
    (choice) =>
      choice.displayName.toLowerCase().includes(needle) ||
      (choice.path?.toLowerCase().includes(needle) ?? false) ||
      choice.hosts.some((host) => host.label.toLowerCase().includes(needle))
  )
}
