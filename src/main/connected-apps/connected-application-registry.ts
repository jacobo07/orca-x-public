import {
  connectedApplicationPartition,
  sanitizePersistedConnectedApplications,
  type ProjectConnectedApplication
} from '../../shared/connected-application'
import type { Project } from '../../shared/project-types'

/**
 * Which partitions belong to connected applications, answered from the projects AT THE MOMENT OF
 * ASKING. will-attach-webview consults this, so a renderer cannot attach a guest to a connected-app
 * partition no project declares — including one removed a second ago, which a cached snapshot would
 * still allow. Unbound, it answers "none", which refuses every connected-app guest.
 */
export class ConnectedApplicationRegistry {
  private readProjects: (() => readonly Project[]) | null = null

  bind(readProjects: () => readonly Project[]): void {
    this.readProjects = readProjects
  }

  private entries(): [string, ProjectConnectedApplication][] {
    const projects = this.readProjects?.() ?? []
    return projects.flatMap((project) =>
      sanitizePersistedConnectedApplications(project.connectedApplications).map(
        (application): [string, ProjectConnectedApplication] => [
          connectedApplicationPartition(application.id),
          application
        ]
      )
    )
  }

  applicationForPartition(partition: string): ProjectConnectedApplication | null {
    return this.entries().find(([candidate]) => candidate === partition)?.[1] ?? null
  }

  partitions(): string[] {
    return this.entries().map(([partition]) => partition)
  }
}

export const connectedApplicationRegistry = new ConnectedApplicationRegistry()
