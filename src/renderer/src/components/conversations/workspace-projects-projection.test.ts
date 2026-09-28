import { describe, expect, it } from 'vitest'
import type {
  WorkspaceAgentRow,
  WorkspaceProjectRef
} from '../../../../shared/cognitive-workspace-projection'
import type { AgentProjectChoice } from '../agents/agent-project-choices'
import { projectWorkspaceProjects } from './workspace-projects-projection'

function choice(projectId: string): AgentProjectChoice {
  return { projectId, displayName: projectId, badgeColor: '#000', hosts: [], path: null, sharesName: false }
}

function agent(id: string, project: WorkspaceProjectRef): WorkspaceAgentRow {
  return {
    agent: { id, name: id, role: '', projectId: null, createdAt: 0, updatedAt: 0 },
    project,
    lastActivityAt: null,
    lastTurnState: null,
    threadCount: 0
  }
}

describe('Workspace projects tab projection', () => {
  // The reported defect: with no agents the tab showed no projects at all.
  it('lists every canonical project even when no agent exists', () => {
    const { projects, orphans } = projectWorkspaceProjects([choice('p1'), choice('p2')], [])
    expect(projects.map((group) => group.choice.projectId)).toEqual(['p1', 'p2'])
    expect(orphans).toEqual([])
  })

  it('places agents under their project and keeps unbound and vanished ones apart', () => {
    const { projects, orphans } = projectWorkspaceProjects(
      [choice('p1')],
      [
        agent('a1', { kind: 'project', projectId: 'p1', displayName: 'p1' }),
        agent('a2', { kind: 'none' }),
        agent('a3', { kind: 'unresolved', projectId: 'gone' }),
        agent('a4', { kind: 'project', projectId: 'stale', displayName: 'stale' })
      ]
    )
    expect(projects[0].agents.map((row) => row.agent.id)).toEqual(['a1'])
    expect(orphans.map((group) => [group.key, group.agents.map((row) => row.agent.id)])).toEqual([
      ['none', ['a2']],
      ['unresolved:gone', ['a3']],
      ['unresolved:stale', ['a4']]
    ])
  })
})
