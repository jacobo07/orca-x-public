import { describe, expect, it } from 'vitest'
import { classifyRequirement, classifyContractRead } from './environment-requirement-state'
import { parseVersionRange } from './environment-version-range'
import type {
  EnvironmentRequirement,
  HostMeasurement,
  RequirementProbeResult
} from './environment-requirement-types'

const HOST = 'ssh:t1@0123456789abcdef'
const NO_APPROVAL = { prepareApproved: false }
const APPROVED = { prepareApproved: true }

function measured(probes: RequirementProbeResult[], os = 'linux', arch = 'x64'): HostMeasurement {
  return { status: 'measured', at: 1700, hostKey: HOST, platform: { os, arch }, probes }
}

function command(overrides: Record<string, unknown> = {}): EnvironmentRequirement {
  return { id: 'git', kind: 'command', name: 'git', versionArg: '--version', ...overrides } as never
}

describe('classifyRequirement', () => {
  it('unreachable host is unknown', () => {
    for (const status of ['unreachable', 'host-predates-probes', 'timed-out', 'refused'] as const) {
      const verdict = classifyRequirement(
        command({ prepare: 'x' }),
        { status, at: 5, hostKey: HOST, detail: 'd' },
        APPROVED
      )
      expect(verdict).toMatchObject({
        state: 'unknown',
        reason: status,
        measuredAt: 5,
        hostKey: HOST
      })
    }
  })

  it('unknown kind is unknown', () => {
    const verdict = classifyRequirement(
      { id: 'gpu0', kind: 'gpu', unsupportedByThisOrca: true },
      measured([]),
      NO_APPROVAL
    )
    expect(verdict).toMatchObject({ state: 'unknown', reason: 'kind-not-evaluated' })
  })

  it('malformed row is unknown', () => {
    const verdict = classifyRequirement(
      { id: 'bad', kind: 'command', malformed: true },
      measured([]),
      NO_APPROVAL
    )
    expect(verdict).toMatchObject({ state: 'unknown', reason: 'malformed-requirement' })
  })

  it('probe refused and failed carry the probe reason', () => {
    const refused = classifyRequirement(
      command(),
      measured([{ id: 'git', outcome: 'refused', reason: 'resolves-inside-workspace' }]),
      NO_APPROVAL
    )
    expect(refused).toMatchObject({ state: 'unknown', reason: 'resolves-inside-workspace' })
    const failed = classifyRequirement(
      command(),
      measured([{ id: 'git', outcome: 'failed', reason: 'unparseable-version' }]),
      NO_APPROVAL
    )
    expect(failed).toMatchObject({ state: 'unknown', reason: 'unparseable-version' })
    const bare = classifyRequirement(
      command(),
      measured([{ id: 'git', outcome: 'failed' }]),
      NO_APPROVAL
    )
    expect(bare).toMatchObject({ state: 'unknown', reason: 'probe-failed' })
  })

  it('a row with no probe answer is unknown', () => {
    expect(classifyRequirement(command(), measured([]), NO_APPROVAL)).toMatchObject({
      state: 'unknown',
      reason: 'probe-missing'
    })
  })

  it('unsupported version range is unknown', () => {
    const verdict = classifyRequirement(
      command({ versionRange: parseVersionRange('^2') }),
      measured([{ id: 'git', outcome: 'found', version: '2.4.0' }]),
      NO_APPROVAL
    )
    expect(verdict).toMatchObject({ state: 'unknown', reason: 'unsupported-version-range' })
  })

  it('platform filter on an unmeasured platform is unknown', () => {
    const verdict = classifyRequirement(
      command({ platforms: [{ os: 'linux' }] }),
      measured([{ id: 'git', outcome: 'found' }], 'unknown', 'unknown'),
      NO_APPROVAL
    )
    expect(verdict).toMatchObject({ state: 'unknown', reason: 'platform-unmeasured' })
  })

  it('platform-skipped is unsupported', () => {
    const verdict = classifyRequirement(
      command({ prepare: 'brew install git', platforms: [{ os: 'darwin' }] }),
      measured([{ id: 'git', outcome: 'skipped-platform', reason: 'platform-mismatch' }]),
      APPROVED
    )
    expect(verdict).toMatchObject({ state: 'unsupported', reason: 'platform-mismatch' })
  })

  it('a platform requirement naming another os is unsupported', () => {
    const verdict = classifyRequirement(
      { id: 'mac', kind: 'platform', os: 'darwin' },
      measured([{ id: 'mac', outcome: 'skipped-platform', reason: 'platform-mismatch' }]),
      NO_APPROVAL
    )
    expect(verdict.state).toBe('unsupported')
  })

  it('satisfied for each evaluated kind', () => {
    const cases: [EnvironmentRequirement, RequirementProbeResult][] = [
      [command(), { id: 'git', outcome: 'found', resolvedPath: '/usr/bin/git' }],
      [
        command({ versionRange: parseVersionRange('>=2.25') }),
        { id: 'git', outcome: 'found', resolvedPath: '/usr/bin/git', version: '2.45.1' }
      ],
      [
        { id: 'a', kind: 'agent', provider: 'claude' },
        { id: 'a', outcome: 'found' }
      ],
      [
        { id: 'e', kind: 'env', name: 'TOKEN' },
        { id: 'e', outcome: 'found', present: true }
      ],
      [
        { id: 'c', kind: 'credential', provider: 'gh' },
        { id: 'c', outcome: 'found', authenticated: true }
      ],
      [
        { id: 'p', kind: 'platform', os: 'linux' },
        { id: 'p', outcome: 'found' }
      ]
    ]
    for (const [requirement, probe] of cases) {
      expect(classifyRequirement(requirement, measured([probe]), NO_APPROVAL).state).toBe(
        'satisfied'
      )
    }
  })

  it('evidence is a version or a path and never output', () => {
    const verdict = classifyRequirement(
      command({ versionRange: parseVersionRange('>=2.25') }),
      measured([{ id: 'git', outcome: 'found', resolvedPath: '/usr/bin/git', version: '2.45.1' }]),
      NO_APPROVAL
    )
    expect(verdict.evidence).toEqual({ version: '2.45.1', resolvedPath: '/usr/bin/git' })
  })

  it('version out of range is incompatible', () => {
    const verdict = classifyRequirement(
      command({ versionRange: parseVersionRange('>=2.25') }),
      measured([{ id: 'git', outcome: 'found', version: '2.10.0' }]),
      NO_APPROVAL
    )
    expect(verdict).toMatchObject({
      state: 'incompatible',
      reason: 'version-out-of-range',
      evidence: { version: '2.10.0' }
    })
  })

  it('found with a wanted range but no version is unknown', () => {
    const verdict = classifyRequirement(
      command({ versionRange: parseVersionRange('>=2.25') }),
      measured([{ id: 'git', outcome: 'found' }]),
      NO_APPROVAL
    )
    expect(verdict).toMatchObject({ state: 'unknown', reason: 'version-missing' })
  })

  it('an absent command with no prepare is missing', () => {
    const verdict = classifyRequirement(
      command(),
      measured([{ id: 'git', outcome: 'absent' }]),
      NO_APPROVAL
    )
    expect(verdict).toMatchObject({ state: 'missing', reason: 'command-absent' })
  })

  it('missing with an unapproved prepare needs authorization', () => {
    const verdict = classifyRequirement(
      command({ prepare: 'apt-get install git' }),
      measured([{ id: 'git', outcome: 'absent' }]),
      NO_APPROVAL
    )
    expect(verdict).toMatchObject({
      state: 'needs-authorization',
      reason: 'prepare-unapproved',
      actor: 'user'
    })
  })

  it('approved prepare stays missing', () => {
    const verdict = classifyRequirement(
      command({ prepare: 'apt-get install git' }),
      measured([{ id: 'git', outcome: 'absent' }]),
      APPROVED
    )
    expect(verdict).toMatchObject({ state: 'missing', reason: 'command-absent' })
  })

  it('incompatible with an unapproved prepare stays incompatible', () => {
    const verdict = classifyRequirement(
      command({ prepare: 'upgrade', versionRange: parseVersionRange('>=2.25') }),
      measured([{ id: 'git', outcome: 'found', version: '1.0.0' }]),
      NO_APPROVAL
    )
    expect(verdict.state).toBe('incompatible')
  })

  it('unauthenticated credential needs authorization', () => {
    const verdict = classifyRequirement(
      { id: 'c', kind: 'credential', provider: 'gh' },
      measured([{ id: 'c', outcome: 'found', authenticated: false }]),
      NO_APPROVAL
    )
    expect(verdict).toMatchObject({
      state: 'needs-authorization',
      reason: 'sign-in-required',
      actor: 'user'
    })
  })

  it('a credential with the CLI absent is missing', () => {
    const verdict = classifyRequirement(
      { id: 'c', kind: 'credential', provider: 'gh' },
      measured([{ id: 'c', outcome: 'absent', reason: 'credential-cli-absent' }]),
      NO_APPROVAL
    )
    expect(verdict).toMatchObject({ state: 'missing', reason: 'credential-cli-absent' })
  })

  it('env unset and agent not detected are missing', () => {
    expect(
      classifyRequirement(
        { id: 'e', kind: 'env', name: 'TOKEN' },
        measured([{ id: 'e', outcome: 'absent', present: false }]),
        NO_APPROVAL
      )
    ).toMatchObject({ state: 'missing', reason: 'env-unset' })
    expect(
      classifyRequirement(
        { id: 'a', kind: 'agent', provider: 'claude' },
        measured([{ id: 'a', outcome: 'absent' }]),
        NO_APPROVAL
      )
    ).toMatchObject({ state: 'missing', reason: 'agent-not-detected' })
  })

  it('an unreachable host with an approved prepare is unknown', () => {
    const verdict = classifyRequirement(
      command({ prepare: 'x' }),
      { status: 'unreachable', at: 1, hostKey: HOST, detail: 'gone' },
      APPROVED
    )
    expect(verdict.state).toBe('unknown')
  })
})

describe('classifyContractRead', () => {
  it('names unreadable and unparseable contracts as unknown', () => {
    expect(classifyContractRead('unreadable', HOST, 3)).toMatchObject({
      state: 'unknown',
      reason: 'contract-unreadable'
    })
    expect(classifyContractRead('unparseable', HOST, 3)).toMatchObject({
      state: 'unknown',
      reason: 'contract-unparseable'
    })
  })

  it('has no verdict for a parsed or absent contract', () => {
    expect(classifyContractRead('parsed', HOST, 3)).toBeNull()
    expect(classifyContractRead('absent', HOST, 3)).toBeNull()
  })
})
