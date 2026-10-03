import { describe, expect, it } from 'vitest'
import { resumeCenterOpenInTarget } from './resume-center-open-in'

const known = (path: string | null) => ({ kind: 'known' as const, name: 'orca', path })

describe('resumeCenterOpenInTarget', () => {
  it('opens a local workspace at its own path, with no connection', () => {
    expect(resumeCenterOpenInTarget({ hostId: 'local', identity: known('C:/repos/orca') })).toEqual(
      {
        worktreePath: 'C:/repos/orca',
        connectionId: null
      }
    )
  })

  it('opens an SSH workspace through the connection its host id encodes', () => {
    expect(
      resumeCenterOpenInTarget({ hostId: 'ssh:gex%2044', identity: known('/home/kobii/orca') })
    ).toEqual({ worktreePath: '/home/kobii/orca', connectionId: 'gex 44' })
  })

  it('refuses a runtime host: its path is not a path on this machine', () => {
    expect(
      resumeCenterOpenInTarget({ hostId: 'runtime:env-1', identity: known('/workspace') })
    ).toBeNull()
  })

  it('refuses a workspace whose folder is missing, unknown or has no recorded path', () => {
    expect(resumeCenterOpenInTarget({ hostId: 'local', identity: { kind: 'missing' } })).toBeNull()
    expect(resumeCenterOpenInTarget({ hostId: 'local', identity: { kind: 'unknown' } })).toBeNull()
    expect(resumeCenterOpenInTarget({ hostId: 'local', identity: known(null) })).toBeNull()
  })

  it('refuses a host id it cannot parse', () => {
    expect(resumeCenterOpenInTarget({ hostId: 'ssh:', identity: known('/x') })).toBeNull()
  })
})
