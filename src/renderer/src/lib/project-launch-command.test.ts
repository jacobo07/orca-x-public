import { describe, expect, it } from 'vitest'
import { PROJECT_LAUNCH_COMMAND, resolveProjectLaunchTarget } from './project-launch-command'

describe('resolveProjectLaunchTarget', () => {
  it('launches a local project at its own path', () => {
    expect(resolveProjectLaunchTarget({ path: 'C:\\projects\\orca' })).toEqual({
      startupCwd: 'C:\\projects\\orca',
      command: PROJECT_LAUNCH_COMMAND
    })
  })

  it('refuses a project with no usable path', () => {
    expect(resolveProjectLaunchTarget({ path: null })).toBeNull()
    expect(resolveProjectLaunchTarget({ path: undefined })).toBeNull()
    expect(resolveProjectLaunchTarget({ path: '   ' })).toBeNull()
  })

  // The dangerous case, and the reason this is a function rather than an inline path read: a remote
  // project's path describes the other host's disk. Spawning a local shell there either fails or —
  // when a directory of the same name happens to exist locally — silently runs the command in a
  // place the user never picked.
  it('refuses a remote project rather than running its path locally', () => {
    expect(
      resolveProjectLaunchTarget({ path: '/home/kobii/app', connectionId: 'ssh-1' })
    ).toBeNull()
  })

  it('still launches when the connection id is explicitly absent', () => {
    expect(resolveProjectLaunchTarget({ path: '/home/me/app', connectionId: null })).not.toBeNull()
  })
})
