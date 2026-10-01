import { describe, expect, it } from 'vitest'
import type { EnvironmentRequirementsMeasurement } from '../shared/environment-requirements-measurement'
import { formatEnvironmentRequirements } from './environment-requirements-format'

const parsedWithGit: EnvironmentRequirementsMeasurement = {
  contractSource: { hostKey: 'local@abc', path: '/p/orca.yaml', contentHash: 'a'.repeat(64) },
  contract: 'parsed',
  requirements: [
    {
      id: 'git',
      kind: 'command',
      name: 'git',
      versionArg: '--version',
      prepare: 'winget install Git.Git'
    },
    { id: 'node', kind: 'command', name: 'node', versionArg: '--version' },
    { id: 'future', kind: 'gpu', unsupportedByThisOrca: true }
  ],
  diagnostics: [],
  measurement: {
    status: 'measured',
    at: 1,
    hostKey: 'local@abc',
    platform: { os: 'linux', arch: 'x64' },
    probes: [{ id: 'git', outcome: 'found', version: '2.52.0', resolvedPath: '/usr/bin/git' }]
  }
}

describe('formatEnvironmentRequirements', () => {
  it('prints each requirement beside its probe result and never claims a prepare ran', () => {
    const text = formatEnvironmentRequirements(parsedWithGit)
    expect(text).toContain('git  command  [prepare declared, not run]  ->  found  2.52.0')
    expect(text).toContain('node  command  ->  no result')
    expect(text).toContain('future  gpu  unsupported by this Orca')
    expect(text).not.toContain('winget')
  })

  it('names a host that could not be measured instead of printing empty results', () => {
    const text = formatEnvironmentRequirements({
      ...parsedWithGit,
      measurement: {
        status: 'host-predates-probes',
        at: 1,
        hostKey: 'ssh:t@abc',
        detail: 'capability-missing'
      }
    })
    expect(text).toContain('NOT MEASURED: host-predates-probes (capability-missing)')
    expect(text).toContain('git  command  [prepare declared, not run]  ->  not measured')
  })

  it('keeps an unreadable contract distinct from an absent one', () => {
    const base = { ...parsedWithGit, contractSource: null, requirements: [] }
    expect(formatEnvironmentRequirements({ ...base, contract: 'absent' })).toContain(
      'Contract: none declared'
    )
    expect(formatEnvironmentRequirements({ ...base, contract: 'unreadable' })).toContain(
      'Contract: UNREADABLE'
    )
  })
})
