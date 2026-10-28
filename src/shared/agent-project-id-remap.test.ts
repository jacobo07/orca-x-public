import { describe, expect, it } from 'vitest'
import { remapAgentProjectIds } from './agent-project-id-remap'
import { remapWorktreeMetaProjectIds } from './worktree-meta-project-id-remap'
import type { WorktreeMeta } from './worktree/meta-types'

const agent = (id: string, projectId: string | null) => ({ id, projectId })

describe('remapAgentProjectIds', () => {
  it('moves only the agents whose project id was replaced', () => {
    const agents = [agent('1', 'repo:a'), agent('2', 'repo:b'), agent('3', 'github:x/y')]

    const result = remapAgentProjectIds(agents, new Map([['repo:b', 'git-root:R']]))

    expect(result.map((entry) => entry.projectId)).toEqual(['repo:a', 'git-root:R', 'github:x/y'])
    expect(result[0]).toBe(agents[0])
  })

  it('leaves an agent owned by no project alone', () => {
    const agents = [agent('1', null)]

    expect(remapAgentProjectIds(agents, new Map([['repo:a', 'git-root:R']]))).toBe(agents)
  })

  it('returns the same array when nothing moved', () => {
    const agents = [agent('1', 'repo:a')]

    expect(remapAgentProjectIds(agents, new Map())).toBe(agents)
    expect(remapAgentProjectIds(agents, new Map([['repo:z', 'git-root:R']]))).toBe(agents)
  })
})

describe('remapWorktreeMetaProjectIds', () => {
  const meta = (projectId?: string) => ({ projectId }) as WorktreeMeta

  it('moves only the worktrees whose project id was replaced', () => {
    const records = { w1: meta('repo:a'), w2: meta('repo:b'), w3: meta() }

    const result = remapWorktreeMetaProjectIds(records, new Map([['repo:b', 'git-root:R']]))

    expect(result.w2?.projectId).toBe('git-root:R')
    expect(result.w1).toBe(records.w1)
    expect(result.w3).toBe(records.w3)
    expect(records.w2?.projectId).toBe('repo:b')
  })

  it('returns the same record when nothing moved', () => {
    const records = { w1: meta('repo:a') }

    expect(remapWorktreeMetaProjectIds(records, new Map())).toBe(records)
    expect(remapWorktreeMetaProjectIds(records, new Map([['repo:z', 'git-root:R']]))).toBe(records)
  })
})
