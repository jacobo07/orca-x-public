import { describe, expect, it } from 'vitest'
import {
  resolveTerminalLaunchProfileReadiness,
  type TerminalLaunchProfileReadinessInputs
} from './terminal-launch-profile-readiness'

const settled: TerminalLaunchProfileReadinessInputs = {
  windowsProbe: { enabled: true, answered: true, isLoading: false, hostPlatform: 'win32' },
  agentDetection: { detectedIds: ['claude'], isLoading: false, detectionFailed: false },
  userProfiles: [{ state: 'available' }, { state: 'prerequisite-missing' }]
}

function readiness(patch: Partial<TerminalLaunchProfileReadinessInputs>) {
  return resolveTerminalLaunchProfileReadiness({ ...settled, ...patch })
}

describe('resolveTerminalLaunchProfileReadiness', () => {
  it('is resolved once every probe has answered', () => {
    expect(readiness({})).toBe('resolved')
  })

  it('treats an absent prerequisite as an answer, not a failure', () => {
    expect(readiness({ userProfiles: [{ state: 'prerequisite-missing' }] })).toBe('resolved')
  })

  it('waits on the first render before the Windows probe has published anything', () => {
    // The probe reports isLoading=false on that render, so only the missing answer says "wait".
    expect(
      readiness({
        windowsProbe: { enabled: true, answered: false, isLoading: false, hostPlatform: null }
      })
    ).toBe('resolving')
  })

  it('waits while the Windows probe is in flight', () => {
    expect(readiness({ windowsProbe: { ...settled.windowsProbe, isLoading: true } })).toBe(
      'resolving'
    )
  })

  it('ignores the Windows probe where it is not used', () => {
    expect(
      readiness({
        windowsProbe: { enabled: false, answered: false, isLoading: false, hostPlatform: null }
      })
    ).toBe('resolved')
  })

  it('waits until agent detection has produced a list', () => {
    expect(
      readiness({ agentDetection: { detectedIds: null, isLoading: false, detectionFailed: false } })
    ).toBe('resolving')
    expect(
      readiness({ agentDetection: { detectedIds: [], isLoading: true, detectionFailed: false } })
    ).toBe('resolving')
  })

  it('waits while a user profile prerequisite is still being probed', () => {
    expect(readiness({ userProfiles: [{ state: 'probing' }] })).toBe('resolving')
  })

  it('reports each probe that could not be asked as unresolvable', () => {
    expect(
      readiness({
        windowsProbe: { enabled: true, answered: true, isLoading: false, hostPlatform: null }
      })
    ).toBe('unresolvable')
    expect(
      readiness({ agentDetection: { detectedIds: null, isLoading: false, detectionFailed: true } })
    ).toBe('unresolvable')
    expect(readiness({ userProfiles: [{ state: 'probe-unavailable' }] })).toBe('unresolvable')
  })

  it('keeps waiting when one probe failed and another is still running', () => {
    expect(
      readiness({
        agentDetection: { detectedIds: null, isLoading: false, detectionFailed: true },
        userProfiles: [{ state: 'probing' }]
      })
    ).toBe('resolving')
  })
})
