import { describe, expect, it } from 'vitest'

import type { AgentGroundingLocation } from '../../../../shared/agent-grounding'

import { describeProvider, describeTurnLocation } from './agent-grounding-presentation'

describe('agent grounding presentation', () => {
  const cases: [AgentGroundingLocation, string][] = [
    [{ outcome: 'resolved', projectId: 'p', path: 'C:\\work\\kc', displayName: 'kc' }, 'ready'],
    [{ outcome: 'no-project' }, 'neutral'],
    [{ outcome: 'unresolved', projectId: 'p' }, 'refused'],
    [{ outcome: 'not-ready', projectId: 'p', setupState: 'setting-up' }, 'caution'],
    [{ outcome: 'remote-host', projectId: 'p', hostId: 'ssh:gex44' as never }, 'refused']
  ]

  it.each(cases)(
    'gives %j the tone %s — positive only where the runner would run',
    (location, tone) => {
      expect(describeTurnLocation(location).tone).toBe(tone)
    }
  )

  it('names the remote host it refuses, and the path it would use', () => {
    expect(
      describeTurnLocation({ outcome: 'remote-host', projectId: 'p', hostId: 'ssh:gex44' as never })
        .detail
    ).toContain('ssh:gex44')
    expect(
      describeTurnLocation({
        outcome: 'resolved',
        projectId: 'p',
        path: 'C:\\work\\kc',
        displayName: 'kc'
      }).detail
    ).toBe('C:\\work\\kc')
  })

  it('keeps the credential detail instead of flattening it to "signed out"', () => {
    const provider = describeProvider({
      driver: 'codex-app-server',
      credential: { state: 'not-ready', detail: 'codex credential is unreadable' }
    })
    expect(provider.credential).toMatchObject({
      tone: 'caution',
      detail: 'codex credential is unreadable'
    })
  })
})
