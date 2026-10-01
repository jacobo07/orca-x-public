import { describe, expect, it } from 'vitest'
import { carryProjectStateThroughIdentityChange } from './project-identity-succession'
import type { Project } from './project-types'

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  displayName: 'Project',
  badgeColor: '#737373',
  sourceRepoIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('carryProjectStateThroughIdentityChange', () => {
  it('keeps the exact-id match and reports no remap', () => {
    const projected = makeProject({ id: 'git:host/acme/app', sourceRepoIds: ['r1'] })
    const previous = makeProject({
      id: 'git:host/acme/app',
      sourceRepoIds: ['r1'],
      updatedAt: 50,
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })

    const result = carryProjectStateThroughIdentityChange([projected], [previous])

    expect(result.projects[0]).toMatchObject({
      id: 'git:host/acme/app',
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
      updatedAt: 50
    })
    expect(result.remappedProjectIds.size).toBe(0)
  })

  it('adopts a prior row through a changed identity key by repo overlap', () => {
    const projected = makeProject({ id: 'github:acme/app', sourceRepoIds: ['r1'] })
    const previous = makeProject({
      id: 'repo:r1',
      sourceRepoIds: ['r1'],
      localWindowsRuntimePreference: { kind: 'windows-host' }
    })

    const result = carryProjectStateThroughIdentityChange([projected], [previous])

    expect(result.projects[0]?.localWindowsRuntimePreference).toEqual({ kind: 'windows-host' })
    expect([...result.remappedProjectIds]).toEqual([['repo:r1', 'github:acme/app']])
  })

  it('ignores prior rows that still exist under their own id', () => {
    const kept = makeProject({ id: 'git:host/acme/app', sourceRepoIds: ['r1'] })
    const renamed = makeProject({ id: 'git:host/acme/tool', sourceRepoIds: ['r2'] })
    const previousKept = makeProject({
      id: 'git:host/acme/app',
      sourceRepoIds: ['r1', 'r2'],
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })

    const result = carryProjectStateThroughIdentityChange([kept, renamed], [previousKept])

    expect(result.projects[1]?.localWindowsRuntimePreference).toBeUndefined()
    expect(result.remappedProjectIds.size).toBe(0)
  })

  it('prefers the prior row sharing the most repos over the more recently updated one', () => {
    const projected = makeProject({ id: 'git:host/acme/merged', sourceRepoIds: ['r1', 'r2'] })
    const wide = makeProject({
      id: 'git:host/acme/wide',
      sourceRepoIds: ['r1', 'r2'],
      updatedAt: 10,
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })
    const narrow = makeProject({
      id: 'git:host/acme/narrow',
      sourceRepoIds: ['r2'],
      updatedAt: 900,
      localWindowsRuntimePreference: { kind: 'windows-host' }
    })

    const result = carryProjectStateThroughIdentityChange([projected], [wide, narrow])

    expect(result.projects[0]?.localWindowsRuntimePreference).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu'
    })
    expect([...result.remappedProjectIds.keys()]).toEqual(['git:host/acme/wide'])
  })

  it('breaks an equal-overlap tie by newest updatedAt, then lowest prior id', () => {
    const projected = makeProject({ id: 'git:host/acme/merged', sourceRepoIds: ['r1', 'r2'] })
    const older = makeProject({
      id: 'git:host/acme/a',
      sourceRepoIds: ['r1'],
      updatedAt: 100,
      localWindowsRuntimePreference: { kind: 'windows-host' }
    })
    const newer = makeProject({
      id: 'git:host/acme/b',
      sourceRepoIds: ['r2'],
      updatedAt: 200,
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })

    expect(
      carryProjectStateThroughIdentityChange([projected], [older, newer]).projects[0]
        ?.localWindowsRuntimePreference
    ).toEqual({ kind: 'wsl', distro: 'Ubuntu' })

    const sameStamp = { ...newer, updatedAt: 100 }
    // Same overlap and same updatedAt: the lexicographically lowest prior id wins, both orders.
    for (const previous of [
      [older, sameStamp],
      [sameStamp, older]
    ]) {
      const result = carryProjectStateThroughIdentityChange([projected], previous)
      expect(result.projects[0]?.localWindowsRuntimePreference).toEqual({ kind: 'windows-host' })
      expect([...result.remappedProjectIds.keys()]).toEqual(['git:host/acme/a'])
    }
  })

  it('lets one prior row be claimed by only one surviving project', () => {
    const left = makeProject({ id: 'git:host/acme/left', sourceRepoIds: ['r1'] })
    const right = makeProject({ id: 'git:host/acme/right', sourceRepoIds: ['r2'] })
    const previous = makeProject({
      id: 'repo:r1',
      sourceRepoIds: ['r1', 'r2'],
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })

    const result = carryProjectStateThroughIdentityChange([left, right], [previous])

    expect(result.projects[0]?.localWindowsRuntimePreference).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu'
    })
    expect(result.projects[1]?.localWindowsRuntimePreference).toBeUndefined()
    expect([...result.remappedProjectIds]).toEqual([['repo:r1', 'git:host/acme/left']])
  })
})

describe('repo: to git-root: merge hand-over', () => {
  const ROOT_ID = `git-root:${'a'.repeat(40)}`
  const application = (id: string) => ({
    id: `capp_${id}`,
    label: id,
    origin: `https://${id}.example.com`,
    signInOrigins: [],
    addedAt: 1
  })
  const merged = () => makeProject({ id: ROOT_ID, sourceRepoIds: ['a', 'b'] })
  const predecessorA = () =>
    makeProject({
      id: 'repo:a',
      sourceRepoIds: ['a'],
      updatedAt: 20,
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
      connectedApplications: [application('aaaaaaaa')]
    })
  const predecessorB = () =>
    makeProject({
      id: 'repo:b',
      sourceRepoIds: ['b'],
      updatedAt: 10,
      localWindowsRuntimePreference: { kind: 'windows-host' },
      connectedApplications: [application('bbbbbbbb')]
    })

  it('claims every contained predecessor and unions their applications, primary first', () => {
    const result = carryProjectStateThroughIdentityChange(
      [merged()],
      [predecessorA(), predecessorB()]
    )

    expect(result.projects[0]?.connectedApplications?.map((entry) => entry.id)).toEqual([
      'capp_aaaaaaaa',
      'capp_bbbbbbbb'
    ])
    expect([...result.remappedProjectIds].sort()).toEqual([
      ['repo:a', ROOT_ID],
      ['repo:b', ROOT_ID]
    ])
    expect(result.projects[0]?.updatedAt).toBe(20)
  })

  it('lets the primary win an application id clash', () => {
    const clash = { ...application('aaaaaaaa'), label: 'from b' }
    const b = { ...predecessorB(), connectedApplications: [clash] }

    const result = carryProjectStateThroughIdentityChange([merged()], [predecessorA(), b])

    expect(result.projects[0]?.connectedApplications).toEqual([
      expect.objectContaining({ id: 'capp_aaaaaaaa', label: 'aaaaaaaa' })
    ])
  })

  it('takes the preference from the predecessor holding the local repo, whatever the order', () => {
    // `b` is the primary (newer) but holds only the remote replica; `a` holds the local one.
    const b = { ...predecessorB(), updatedAt: 99 }

    for (const previous of [
      [predecessorA(), b],
      [b, predecessorA()]
    ]) {
      const result = carryProjectStateThroughIdentityChange([merged()], previous, new Set(['a']))
      expect(result.projects[0]?.localWindowsRuntimePreference).toEqual({
        kind: 'wsl',
        distro: 'Ubuntu'
      })
    }
  })

  it('fills an absent preference in primary order when no claimed predecessor is local', () => {
    const bare = { ...predecessorA(), localWindowsRuntimePreference: undefined }

    const result = carryProjectStateThroughIdentityChange([merged()], [bare, predecessorB()])

    expect(result.projects[0]?.localWindowsRuntimePreference).toEqual({ kind: 'windows-host' })
  })

  it('keeps the primary preference when two predecessors are both local', () => {
    // The stated cost: two repo rows of one repository on this host, two different preferences.
    const result = carryProjectStateThroughIdentityChange(
      [merged()],
      [predecessorB(), predecessorA()],
      new Set(['a', 'b'])
    )

    // The holders are tried in claim order: `a` is the primary (newer updatedAt).
    expect(result.projects[0]?.localWindowsRuntimePreference).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu'
    })
  })

  it('does not claim a predecessor holding a repo the root project does not contain', () => {
    const spread = makeProject({
      id: 'repo:c',
      sourceRepoIds: ['b', 'c'],
      connectedApplications: [application('cccccccc')]
    })

    const result = carryProjectStateThroughIdentityChange([merged()], [predecessorA(), spread])

    expect([...result.remappedProjectIds]).toEqual([['repo:a', ROOT_ID]])
    expect(result.projects[0]?.connectedApplications?.map((entry) => entry.id)).toEqual([
      'capp_aaaaaaaa'
    ])
  })

  it('leaves a 1:1 promotion to a non-root key exactly as before', () => {
    const projected = makeProject({ id: 'git:host/acme/app', sourceRepoIds: ['a', 'b'] })

    const result = carryProjectStateThroughIdentityChange(
      [projected],
      [predecessorA(), predecessorB()],
      new Set(['b'])
    )

    expect([...result.remappedProjectIds]).toEqual([['repo:a', 'git:host/acme/app']])
    expect(result.projects[0]?.localWindowsRuntimePreference).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu'
    })
  })

  it('lets a git-root: row that already exists claim an orphaned predecessor that joins it', () => {
    const existing = makeProject({ id: ROOT_ID, sourceRepoIds: ['a', 'b'], updatedAt: 5 })

    const result = carryProjectStateThroughIdentityChange([merged()], [existing, predecessorB()])

    expect(result.projects[0]?.connectedApplications?.map((entry) => entry.id)).toEqual([
      'capp_bbbbbbbb'
    ])
    expect([...result.remappedProjectIds]).toEqual([['repo:b', ROOT_ID]])
  })
})
