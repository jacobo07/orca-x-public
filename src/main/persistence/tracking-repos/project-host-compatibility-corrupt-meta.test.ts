import { describe, expect, it } from 'vitest'
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
