import { describe, expect, it } from 'vitest'

import type { Agent } from './agent-types'
import {
  projectWorkspaceAgents,
  projectWorkspaceThreads
} from './cognitive-workspace-projection'
import type { ConversationSummary } from './conversation-summary'
import type { Project } from './project-types'

const project = (id: string, displayName: string): Project => ({
  id,
  displayName,
  badgeColor: '#000',
  sourceRepoIds: [],
  createdAt: 0,
  updatedAt: 0
})

const agent = (id: string, projectId: string | null): Agent => ({
  id,
  name: id.toUpperCase(),
  role: 'r',
  projectId,
  createdAt: 0,
  updatedAt: 0
})

const thread = (
  id: string,
  agentId: string | null,
  updatedAt: number,
  projectId: string | null = null
): ConversationSummary => ({
  outcome: 'ok',
  id: id as never,
  title: id,
  createdAt: 0,
  updatedAt,
  projectId,
  agentId,
  messageCount: 1,
  lastTurnState: 'completed'
})

describe('cognitive workspace projection', () => {
  const projects = [project('p1', 'KobiiCraft')]

  it('places a thread in its AGENT’s project, ignoring the record’s own projectId', () => {
    const rows = projectWorkspaceThreads(
      [thread('conv_a', 'agent_h', 5, 'p-stale')],
      [agent('agent_h', 'p1')],
      projects
    )
    expect(rows[0]).toMatchObject({
      project: { kind: 'project', projectId: 'p1', displayName: 'KobiiCraft' },
      agent: { kind: 'agent', agentId: 'agent_h', name: 'AGENT_H' }
    })
  })

  it('keeps missing-agent, unresolved-project and unreadable threads distinct and present', () => {
    const rows = projectWorkspaceThreads(
      [
        thread('conv_gone', 'agent_x', 3),
        thread('conv_lost', 'agent_l', 2),
        { outcome: 'unreadable', id: 'conv_bad' as never, reason: 'truncated' }
      ],
      [agent('agent_l', 'p-deleted')],
      projects
    )
    expect(rows.map((row) => row.outcome === 'ok' && [row.agent?.kind, row.project.kind])).toEqual([
      ['missing', 'unknown'],
      ['agent', 'unresolved'],
      false
    ])
    expect(rows).toHaveLength(3)
  })

  it('credits each agent with its newest thread and nothing when it has none', () => {
    const rows = projectWorkspaceAgents(
      [agent('agent_h', 'p1'), agent('agent_a', null)],
      projects,
      [thread('conv_1', 'agent_h', 10), thread('conv_2', 'agent_h', 40), thread('conv_3', null, 99)]
    )
    expect(rows[0]).toMatchObject({ lastActivityAt: 40, threadCount: 2 })
    expect(rows[1]).toMatchObject({
      project: { kind: 'none' },
      lastActivityAt: null,
      lastTurnState: null,
      threadCount: 0
    })
  })
})
