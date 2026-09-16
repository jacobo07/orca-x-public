import { describe, expect, it } from 'vitest'
import { resolveTerminalLaunchProfileIdentity } from '../../../src/shared/terminal-launch-profile-identity'
import type { MobileSessionTab } from './mobile-session-route-types'

// The mobile half of the launch-profile lineage. Two things are being established, and
// only one of them is about logic.
//
// First, PORTABILITY. The parity ledger asserted the derivation module is "portable
// as-is" to mobile. That was a claim about an import that nothing had performed -- and
// the module does carry a value import (WINDOWS_GIT_BASH_SHELL), not only types, so it
// was not self-evident. This file runs under mobile's own vitest, so if the module could
// not be reached from here the file would not run at all.
//
// Second, OLD-PEER HONESTY. launchProfileId is an optional field on a published row, so
// a host older than the lineage fix simply omits it. That host is indistinguishable from
// one whose tab genuinely recorded nothing, and BOTH must degrade to the answer mobile
// already gave -- inferred where there is a hint, unknown where there is not. Neither may
// become "the default profile", which would present this client's local configuration as
// the user's recorded choice.
//
// Parity ledger: terminal.launch-profile-identity.

function terminalTab(fields: Partial<MobileSessionTab & { type: 'terminal' }>): {
  launchProfileId?: string
  launchAgent?: 'claude'
} {
  const tab = {
    type: 'terminal' as const,
    id: 'tab::leaf',
    title: 'Terminal',
    terminal: 'handle-1',
    isActive: true,
    ...fields
  } as MobileSessionTab & { type: 'terminal' }
  return { launchProfileId: tab.launchProfileId, launchAgent: tab.launchAgent as 'claude' }
}

describe('what a mobile client can say about where a terminal came from', () => {
  it('reports RECORDED when the host carried the field', () => {
    // Deliberately a profile inference cannot produce: the same row carries
    // launchAgent 'claude', whose inference is 'agent:claude'. So this answer can only
    // have come from the recorded field.
    const identity = resolveTerminalLaunchProfileIdentity(
      terminalTab({ launchProfileId: 'shell:git-bash-ops', launchAgent: 'claude' })
    )

    expect(identity).toEqual({ source: 'recorded', profileId: 'shell:git-bash-ops' })
  })

  it('OLD PEER — a host that omits the field still infers, and says it inferred', () => {
    // Exactly the row a pre-lineage host publishes: launchAgent present, no profile.
    // Mobile is no worse off than before the wire change, and it does not pretend.
    const identity = resolveTerminalLaunchProfileIdentity(terminalTab({ launchAgent: 'claude' }))

    expect(identity).toEqual({ source: 'inferred', profileId: 'agent:claude' })
    expect(identity.source).not.toBe('recorded')
  })

  it('OLD PEER — with no hint at all the answer is unknown, never a default', () => {
    const identity = resolveTerminalLaunchProfileIdentity(terminalTab({}))

    expect(identity).toEqual({ source: 'unknown' })
    // The failure this guards is silent: a client that answered with its own default
    // profile here would look identical to one that knew, and would attribute a choice
    // to the user that the user never made.
    expect(identity).not.toHaveProperty('profileId')
  })

  it('an empty or whitespace profile id is not a recorded identity', () => {
    // A host that carries the field but has nothing in it has told us nothing. Trimming
    // to empty must fall through to the same answers as absence, or "recorded" becomes
    // reachable with no content behind it.
    expect(resolveTerminalLaunchProfileIdentity(terminalTab({ launchProfileId: '   ' }))).toEqual({
      source: 'unknown'
    })
    expect(
      resolveTerminalLaunchProfileIdentity(
        terminalTab({ launchProfileId: '  ', launchAgent: 'claude' })
      )
    ).toEqual({ source: 'inferred', profileId: 'agent:claude' })
  })

  it('recorded and inferred are never equal, even when they name the same profile', () => {
    // The distinction is the capability. If these ever compared equal, every assertion
    // above would still pass while the thing being protected had collapsed.
    const recorded = resolveTerminalLaunchProfileIdentity(
      terminalTab({ launchProfileId: 'agent:claude' })
    )
    const inferred = resolveTerminalLaunchProfileIdentity(terminalTab({ launchAgent: 'claude' }))

    expect(recorded.source).toBe('recorded')
    expect(inferred.source).toBe('inferred')
    expect(recorded).not.toEqual(inferred)
  })
})
