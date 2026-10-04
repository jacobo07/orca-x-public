import { describe, expect, it } from 'vitest'
import type { Agent } from '../../../shared/agent-types'
import { remapAgentProjectIds } from '../../../shared/agent-project-id-remap'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { remapWorktreeMetaProjectIds } from '../../../shared/worktree-meta-project-id-remap'
import {
  mergeProjectHostSetupCompatibilityState,
  projectHostSetupCompatibilityStateEqual,
  type ProjectHostSetupCompatibilityState
} from './project-host-compatibility'

// Persisted JSON is untrusted: null and scalar entries are a real corrupt-file input class (W-10).
function corruptMeta(projectId: string): Record<string, WorktreeMeta> {
  return {
    'r1::/tmp/null': null,
    'r1::/tmp/scalar': 5,
    'r1::/tmp/valid': { projectId }
  } as unknown as Record<string, WorktreeMeta>
}

function stateWith(worktreeMeta: Record<string, WorktreeMeta>): ProjectHostSetupCompatibilityState {
  return { projects: [], projectHostSetups: [], worktreeMeta }
}

describe('project-host compatibility with corrupt worktreeMeta entries', () => {
  it('compares state without throwing and reads only the valid entry as dependent metadata', () => {
    // Arrange
    const state = stateWith(corruptMeta('p1'))

    // Act
    const sameState = projectHostSetupCompatibilityStateEqual(state, stateWith(corruptMeta('p1')))
    const movedProject = projectHostSetupCompatibilityStateEqual(
      state,
      stateWith(corruptMeta('p2'))
    )

    // Assert
    expect(sameState).toBe(true)
    expect(movedProject).toBe(false)
  })

  it('merges without throwing and leaves the corrupt entries for the normalizer', () => {
    // Arrange
    const state = stateWith(corruptMeta('p1'))

    // Act
    const merged = mergeProjectHostSetupCompatibilityState(state, [] as Repo[])

    // Assert
    expect(merged.worktreeMeta).toEqual(corruptMeta('p1'))
    expect(merged.worktreeMeta).toHaveProperty('r1::/tmp/null', null)
    expect(merged.worktreeMeta).toHaveProperty('r1::/tmp/scalar', 5)
  })

  it('remaps the valid sibling and skips the corrupt entries untouched', () => {
    // Arrange
    const meta = corruptMeta('old-project')

    // Act
    const remapped = remapWorktreeMetaProjectIds(meta, new Map([['old-project', 'new-project']]))

    // Assert
    expect(remapped['r1::/tmp/valid']).toEqual({ projectId: 'new-project' })
    expect(remapped['r1::/tmp/null']).toBeNull()
    expect(remapped['r1::/tmp/scalar']).toBe(5)
  })

  it('treats an array entry as corrupt rather than as metadata', () => {
    // Arrange
    const meta = { 'r1::/tmp/array': [] } as unknown as Record<string, WorktreeMeta>

    // Act
    const remapped = remapWorktreeMetaProjectIds(meta, new Map([['old-project', 'new-project']]))

    // Assert
    expect(remapped).toBe(meta)
  })
})

// Persisted JSON is untrusted: the agents catalog is read by the same merge as worktreeMeta (WR-02 of 08-REVIEW).
function agentsState(agents: unknown): ProjectHostSetupCompatibilityState {
  return { projects: [], projectHostSetups: [], agents: agents as Agent[] }
}

describe('project-host compatibility with corrupt agents entries', () => {
  it.each([
    ['a null entry', [null]],
    ['a scalar entry', [5]],
    ['an array entry', [[]]],
    ['a non-array catalog', {}]
  ])('compares state without throwing on %s', (_label, agents) => {
    // Arrange
    const state = agentsState(agents)

    // Act
    const same = projectHostSetupCompatibilityStateEqual(state, agentsState(agents))

    // Assert
    expect(same).toBe(true)
  })

  it('reads only the valid agent as dependent state', () => {
    // Arrange
    const withProject = (projectId: string) =>
      agentsState([null, { id: 'a1', projectId }, 7] as unknown)

    // Act
    const moved = projectHostSetupCompatibilityStateEqual(withProject('p1'), withProject('p2'))

    // Assert
    expect(moved).toBe(false)
  })

  it.each([
    ['a corrupt entry beside a valid agent', [null, { id: 'a1', projectId: 'p1' }]],
    ['a non-array catalog', {}]
  ])('merges without throwing on %s and leaves the catalog for its owner', (_label, agents) => {
    // Arrange
    const state = agentsState(agents)

    // Act
    const merged = mergeProjectHostSetupCompatibilityState(state, [] as Repo[])

    // Assert
    expect(merged.projects).toEqual([])
    if (Array.isArray(agents)) {
      expect(merged.agents).toEqual(agents)
    } else {
      expect(merged.agents).toBeUndefined()
    }
  })

  it('remaps the valid agent and skips corrupt entries untouched', () => {
    // Arrange
    const agents = [null, 5, { id: 'a1', projectId: 'old-project' }] as unknown as Agent[]

    // Act
    const remapped = remapAgentProjectIds(agents, new Map([['old-project', 'new-project']]))

    // Assert
    expect(remapped[0]).toBeNull()
    expect(remapped[1]).toBe(5)
    expect(remapped[2]).toMatchObject({ projectId: 'new-project' })
  })
})
