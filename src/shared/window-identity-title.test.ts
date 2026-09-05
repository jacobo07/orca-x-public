import { describe, expect, it } from 'vitest'
import { buildWindowIdentityTitle } from './window-identity-title'

const BRAND = 'Orca X'

describe('buildWindowIdentityTitle', () => {
  it('falls back to the brand when the window owns no project', () => {
    // Arrange — a workspace window that has not been bound yet.
    const identity = { projectName: null, worktreeName: null }

    // Act
    const title = buildWindowIdentityTitle(identity, BRAND)

    // Assert
    expect(title).toBe(BRAND)
  })

  it('leads with the project so two windows are distinguishable at a glance', () => {
    expect(buildWindowIdentityTitle({ projectName: 'KobiiCraft', worktreeName: null }, BRAND)).toBe(
      'KobiiCraft — Orca X'
    )
    expect(buildWindowIdentityTitle({ projectName: 'InfinityOps', worktreeName: null }, BRAND)).toBe(
      'InfinityOps — Orca X'
    )
  })

  it('adds the worktree only when it says something the project name does not', () => {
    // Same name carries no information — a repo opened at its main workspace.
    expect(
      buildWindowIdentityTitle({ projectName: 'KobiiCraft', worktreeName: 'KobiiCraft' }, BRAND)
    ).toBe('KobiiCraft — Orca X')

    // A distinct worktree is what separates two windows on ONE repo.
    expect(
      buildWindowIdentityTitle({ projectName: 'KobiiCraft', worktreeName: 'w0-durability' }, BRAND)
    ).toBe('KobiiCraft — w0-durability — Orca X')
  })

  it('treats a blank or whitespace name as unknown rather than emitting a dangling separator', () => {
    expect(buildWindowIdentityTitle({ projectName: '   ', worktreeName: null }, BRAND)).toBe(BRAND)
    expect(
      buildWindowIdentityTitle({ projectName: 'KobiiCraft', worktreeName: '  ' }, BRAND)
    ).toBe('KobiiCraft — Orca X')
    expect(buildWindowIdentityTitle({ projectName: null, worktreeName: 'stray' }, BRAND)).toBe(
      BRAND
    )
  })

  it('trims surrounding whitespace instead of carrying it into the window title', () => {
    expect(
      buildWindowIdentityTitle({ projectName: '  KobiiCraft  ', worktreeName: null }, BRAND)
    ).toBe('KobiiCraft — Orca X')
  })

  it('ignores worktree case differences when deciding the name is redundant', () => {
    expect(
      buildWindowIdentityTitle({ projectName: 'KobiiCraft', worktreeName: 'kobiicraft' }, BRAND)
    ).toBe('KobiiCraft — Orca X')
  })
})
