import { describe, expect, it } from 'vitest'
import { canonicalRepoKey, lineageKeyOf, localRepoKey, workspaceRefOf } from './workspace-identity'

describe('canonicalRepoKey', () => {
  it.each([
    'git@github.com:jacobo07/orca-x.git',
    'https://github.com/jacobo07/orca-x.git',
    'https://github.com/jacobo07/orca-x',
    'https://token@github.com/jacobo07/orca-x.git',
    'ssh://git@github.com:22/jacobo07/orca-x.git',
    'https://GitHub.com/Jacobo07/Orca-X/'
  ])('gives %s one key', (url) => {
    expect(canonicalRepoKey(url)).toBe('github.com/jacobo07/orca-x')
  })

  it.each([
    'git@ssh.dev.azure.com:v3/Org/Proj/Repo',
    'https://org@dev.azure.com/Org/Proj/_git/Repo',
    'https://org.visualstudio.com/Proj/_git/Repo'
  ])('gives the Azure spelling %s one key', (url) => {
    expect(canonicalRepoKey(url)).toBe('dev.azure.com/org/proj/repo')
  })

  it('keeps different repositories apart', () => {
    expect(canonicalRepoKey('git@github.com:jacobo07/a.git')).not.toBe(
      canonicalRepoKey('git@github.com:jacobo07/b.git')
    )
  })

  it.each(['C:\\repos\\orca', '/home/<user>/orca', 'orca', '', 'https://'])(
    'refuses %j, which is no remote',
    (text) => {
      expect(canonicalRepoKey(text)).toBeNull()
    }
  )
})

describe('workspaceRefOf', () => {
  it('is the same on every host, because neither host nor path goes into it', () => {
    const onPc = workspaceRefOf(
      'github.com/a/b',
      lineageKeyOf('main', 'instance-pc', 'repo::C:\\w')
    )
    const onGex44 = workspaceRefOf(
      'github.com/a/b',
      lineageKeyOf('main', 'instance-gex', 'repo::/srv/w')
    )

    expect(onPc).toBe(onGex44)
    expect(onPc).toMatch(/^wsr_[0-9a-f]{32}$/)
  })

  it('separates branches of one repository', () => {
    expect(workspaceRefOf('r', lineageKeyOf('main', null, 'w'))).not.toBe(
      workspaceRefOf('r', lineageKeyOf('fix', null, 'w'))
    )
  })

  it('keeps detached worktrees apart from each other', () => {
    expect(workspaceRefOf('r', lineageKeyOf(null, 'one', 'w'))).not.toBe(
      workspaceRefOf('r', lineageKeyOf(null, 'two', 'w'))
    )
  })

  it('does not let a branch collide with a detached worktree of the same name', () => {
    expect(lineageKeyOf('x', null, 'w')).not.toBe(lineageKeyOf(null, 'x', 'w'))
  })

  it('does not let the separator join two different pairs', () => {
    expect(workspaceRefOf('a\nb', 'c')).not.toBe(workspaceRefOf('a', 'b\nc'))
  })
})

describe('localRepoKey', () => {
  it('cannot be confused with a remote key', () => {
    expect(localRepoKey('ABC123 ')).toBe('root:abc123')
  })
})
