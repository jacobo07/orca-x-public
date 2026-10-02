import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type {
  Project,
  ProjectHostSetup,
  ProjectHostSetupState
} from '../../../../shared/project-types'
import type { RuntimeCompatVerdict } from '../../../../shared/protocol-compat'
import {
  HOST_REACHABILITIES,
  deriveHostReachability,
  hostVouches,
  isSshConnectionFailure,
  type HostReachability,
  type SshConnectionFailure
} from '@/lib/host-reachability'
import type {
  RunningSessionLiveness,
  WorkspaceRunningSession
} from '../conversations/workspace-running-sessions'
import type { SidebarHostOption } from '../sidebar/sidebar-host-options'

/** An agent on a host that is not reachable has no voucher, so its last state is not shown. */
export type WorkstationAgentState = Exclude<RunningSessionLiveness, 'host-unvouched'> | 'unknown'

export type WorkstationProject = {
  setupId: string
  projectId: string
  name: string
  path: string
  setupState: ProjectHostSetupState
}

export type WorkstationAgent = {
  paneKey: string
  title: string
  projectName: string | null
  state: WorkstationAgentState
}

export type WorkstationNode = {
  hostId: ExecutionHostId
  /** null = a setup or session names a host the registry does not know. */
  host: SidebarHostOption | null
  label: string
  reachability: HostReachability
  /** Why Orca's last attempt failed, when it did. */
  failure: SshConnectionFailure | 'runtime-error' | null
  blocked: Extract<RuntimeCompatVerdict, { kind: 'blocked' }>['reason'] | null
  projects: WorkstationProject[]
  agents: WorkstationAgent[]
}

export type WorkstationSummary = {
  hosts: number
  byReachability: Record<HostReachability, number>
  projectsSetUp: number
  agents: number
}

function failureOf(host: SidebarHostOption): WorkstationNode['failure'] {
  if (host.kind === 'ssh' && isSshConnectionFailure(host.connectionStatus)) {
    return host.connectionStatus
  }
  return host.kind === 'runtime' && host.health === 'error' ? 'runtime-error' : null
}

export function buildWorkstation(input: {
  hosts: readonly SidebarHostOption[]
  setups: readonly ProjectHostSetup[]
  projects: readonly Pick<Project, 'id' | 'displayName'>[]
  sessions: readonly WorkspaceRunningSession[]
}): { nodes: WorkstationNode[]; summary: WorkstationSummary } {
  const projectName = new Map(input.projects.map((project) => [project.id, project.displayName]))
  const nodes = new Map<ExecutionHostId, WorkstationNode>()
  const nodeFor = (hostId: ExecutionHostId): WorkstationNode => {
    const existing = nodes.get(hostId)
    if (existing) {
      return existing
    }
    // Why: a setup or agent on a host the registry lost still exists; dropping it would hide it.
    const orphan: WorkstationNode = {
      hostId,
      host: null,
      label: hostId,
      reachability: 'unknown',
      failure: null,
      blocked: null,
      projects: [],
      agents: []
    }
    nodes.set(hostId, orphan)
    return orphan
  }

  for (const host of input.hosts) {
    nodes.set(host.id, {
      hostId: host.id,
      host,
      label: host.label,
      reachability: deriveHostReachability(host),
      failure: failureOf(host),
      blocked:
        host.health === 'blocked' && host.compatibility?.kind === 'blocked'
          ? host.compatibility.reason
          : null,
      projects: [],
      agents: []
    })
  }
  for (const setup of input.setups) {
    nodeFor(setup.hostId).projects.push({
      setupId: setup.id,
      projectId: setup.projectId,
      name: projectName.get(setup.projectId) ?? setup.displayName,
      path: setup.path,
      setupState: setup.setupState
    })
  }
  for (const session of input.sessions) {
    const node = nodeFor(session.hostId)
    node.agents.push({
      paneKey: session.paneKey,
      title: session.title,
      projectName: session.projectId ? (projectName.get(session.projectId) ?? null) : null,
      state:
        hostVouches(node.reachability) && session.liveness !== 'host-unvouched'
          ? session.liveness
          : 'unknown'
    })
  }

  const ordered = [...nodes.values()].sort((a, b) => {
    const rank = (node: WorkstationNode): number =>
      node.hostId === LOCAL_EXECUTION_HOST_ID ? 0 : node.host === null ? 2 : 1
    return rank(a) - rank(b) || a.label.localeCompare(b.label)
  })
  for (const node of ordered) {
    node.projects.sort((a, b) => a.name.localeCompare(b.name))
  }

  const byReachability = Object.fromEntries(
    HOST_REACHABILITIES.map((reachability) => [reachability, 0])
  ) as Record<HostReachability, number>
  for (const node of ordered) {
    byReachability[node.reachability] += 1
  }
  return {
    nodes: ordered,
    summary: {
      hosts: ordered.length,
      byReachability,
      projectsSetUp: ordered.reduce(
        (sum, node) => sum + node.projects.filter((p) => p.setupState === 'ready').length,
        0
      ),
      agents: ordered.reduce((sum, node) => sum + node.agents.length, 0)
    }
  }
}
