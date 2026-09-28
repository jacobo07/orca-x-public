import { describe, expect, it } from 'vitest'

import { resolveDefaultProjectId } from './default-agent-project'
import type { Project } from '../../../../shared/project-types'

function project(id: string, sourceRepoIds: string[]): Project {
  return {
    id,
    displayName: id,
    badgeColor: '#000000',
    sourceRepoIds,
    createdAt: 0,
    updatedAt: 0
  }
}

const PROJECTS = [project('p1', ['repo-a', 'repo-b']), project('p2', ['repo-c'])]

describe('resolveDefaultProjectId', () => {
  it('picks the project that holds the repo you are in', () => {
    expect(resolveDefaultProjectId('repo-c', PROJECTS)).toBe('p2')
    expect(resolveDefaultProjectId('repo-b', PROJECTS)).toBe('p1')
  })

  it('answers null when nothing says which repo you are in', () => {
    // The regression this file exists for: the page read a store key that does not exist on
    // AppState, so this input was `undefined` on every render and the answer was always null. Both
    // falsy inputs are covered because `undefined` is what a wrong selector actually produces.
    expect(resolveDefaultProjectId(null, PROJECTS)).toBeNull()
    expect(resolveDefaultProjectId(undefined, PROJECTS)).toBeNull()
    expect(resolveDefaultProjectId('', PROJECTS)).toBeNull()
  })

  it('answers null rather than guessing when the repo belongs to no project', () => {
    // Never "the first one". An unowned repo means we do not know, and saying so is the honest
    // answer — the user still picks, they just start from nothing.
    expect(resolveDefaultProjectId('repo-unknown', PROJECTS)).toBeNull()
  })

  it('answers null with no projects at all', () => {
    expect(resolveDefaultProjectId('repo-a', [])).toBeNull()
  })

  it('returns a real project id, so a wrong selector cannot pass by returning null everywhere', () => {
    // The positive control. Without it, a resolver that answered null unconditionally would satisfy
    // every assertion above — which is exactly the shape of the bug this replaced.
    expect(resolveDefaultProjectId('repo-a', PROJECTS)).toBe('p1')
  })
})
