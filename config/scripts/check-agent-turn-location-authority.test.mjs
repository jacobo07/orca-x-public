import { describe, expect, it } from 'vitest'

import {
  classifyTurnEntrances,
  consultsRemoteDriver,
  findHostBlindResumeSites,
  findTurnEntrances,
  findInventedLocationSites,
  isTestPath,
  resumesByHost,
  stripComments
} from './check-agent-turn-location-authority.mjs'

describe('consultsRemoteDriver', () => {
  it('accepts a runner that CALLS the remote driver selection, either spelling', () => {
    expect(consultsRemoteDriver('const remote = deps.remoteDriverFor?.({ hostId })')).toBe(true)
    expect(consultsRemoteDriver('const remote = deps.remoteDriverFor({ hostId })')).toBe(true)
  })

  it('refuses a runner that only DECLARES it or mentions it in a comment', () => {
    // The W-C5 lesson: a positive control matching a bare identifier stayed green after the call
    // was replaced by a literal. The type declaration and the prose must not satisfy it.
    const declaredOnly = `
      type Deps = { remoteDriverFor?: (target: Target) => Driver | null }
      // remoteDriverFor(target) used to be asked here
      const remote = null
    `
    expect(consultsRemoteDriver(declaredOnly)).toBe(false)
  })
})

// The subjects here are SYNTHETIC. A drill pinned to a real offender has an interest in that
// offender surviving, and stops asserting anything the day it is fixed — which, for this gate, is
// the day it landed. These files represent the CLASS and cannot be fixed out from under the test.

const INVENTING = {
  path: 'src/main/conversation/some-future-turn-builder.ts',
  source: `
    export function buildTurn(request) {
      return { cwd: request.cwd ?? process.cwd() }
    }
  `
}

const LOCATED = {
  path: 'src/main/conversation/another-turn-builder.ts',
  source: `
    export function buildTurn(request, location) {
      return { cwd: location.path }
    }
  `
}

describe('findInventedLocationSites', () => {
  it('catches a module that falls back to the process directory', () => {
    // The RED half. Without this, a gate that had silently stopped matching would report exactly
    // what a clean turn path reports.
    expect(findInventedLocationSites([INVENTING, LOCATED])).toEqual([INVENTING.path])
  })

  it('passes a module that takes its location from a resolved project', () => {
    // The GREEN half, beside the red one: a detector that flagged everything would satisfy the
    // case above and look like it works.
    expect(findInventedLocationSites([LOCATED])).toEqual([])
  })

  it('catches the spaced and split spellings, not just the tidy one', () => {
    const spaced = {
      path: 'src/main/conversation/spaced.ts',
      source: 'const here = process . cwd ()'
    }
    expect(findInventedLocationSites([spaced])).toEqual([spaced.path])
  })

  it('does not accuse a module for describing the rule in a comment', () => {
    // Every module that honours this rule says so in prose. A gate that accused its own
    // documentation would be switched off within a week.
    const documented = {
      path: 'src/main/conversation/documented.ts',
      source: `
        // Never process.cwd(): on a packaged build that is Orca's own install directory.
        /* The old code called process.cwd() here. */
        export const cwd = (location) => location.path
      `
    }
    expect(findInventedLocationSites([documented])).toEqual([])
  })

  it('exempts tests, which must be able to name the invention to assert it is gone', () => {
    const spec = {
      path: 'src/main/conversation/agent-turn-runs-in-its-project.test.ts',
      source: 'expect(driverCalls[0].cwd).not.toBe(process.cwd())'
    }
    expect(isTestPath(spec.path)).toBe(true)
    expect(findInventedLocationSites([spec])).toEqual([])
  })

  it('normalises windows separators so the same file is not reported twice', () => {
    const windows = {
      path: 'src\\main\\conversation\\win.ts',
      source: 'const here = process.cwd()'
    }
    expect(findInventedLocationSites([windows])).toEqual(['src/main/conversation/win.ts'])
  })
})

// ASCENDED baseline: a location is a path AND a host. The violator is FUTURE-LIKE and synthetic —
// the next cognitive feature to continue a provider thread, written the obvious way.
const HOST_BLIND = {
  path: 'src/main/agent-digest/nightly-digest-runner.ts',
  source: `
    export async function continueDigest(record, driver) {
      const binding = latestProviderProvenance(
        record
      )
      return driver.runTurn({ resumeSessionId: binding?.providerSessionId ?? null })
    }
  `
}
const HOST_SCOPED = {
  path: 'src/main/agent-digest/nightly-digest-runner.ts',
  source: 'const binding = latestProviderProvenance(record, location.hostId)'
}

describe('findHostBlindResumeSites', () => {
  it('catches a future feature that resumes a thread without naming its host', () => {
    expect(findHostBlindResumeSites([HOST_BLIND])).toEqual([HOST_BLIND.path])
  })

  it('passes the same feature once it names the host', () => {
    expect(findHostBlindResumeSites([HOST_SCOPED])).toEqual([])
  })

  it('exempts tests and prose', () => {
    expect(
      findHostBlindResumeSites([
        { path: 'src/shared/conversation-identity.test.ts', source: 'latestProviderProvenance(r)' },
        { path: 'src/main/x.ts', source: '// latestProviderProvenance(record) is host-blind' }
      ])
    ).toEqual([])
  })
})

describe('resumesByHost', () => {
  it('holds for a runner that looks its thread up by host, and not for one that dropped it', () => {
    expect(resumesByHost('latestProviderProvenance(existing.record, executionHostId)')).toBe(true)
    expect(resumesByHost('latestProviderProvenance(existing.record)')).toBe(false)
  })
})

describe('turn entrances (Phase 9)', () => {
  const RUNTIME_ENTRANCE = {
    path: 'src/main/runtime/rpc/conversation-methods.ts',
    source: 'export const sendTurn = (deps, request) => runConversationTurn(deps, request)'
  }
  const DEFINITION = {
    path: 'src/main/conversation/conversation-turn-runner.ts',
    source: 'export async function runConversationTurn(deps, request) {}'
  }

  it('flags a new surface that can start a turn and was never classified', () => {
    const found = findTurnEntrances([RUNTIME_ENTRANCE, DEFINITION])
    // The definition is not an entrance; a caller is.
    expect(found).toEqual([RUNTIME_ENTRANCE.path])
    expect(classifyTurnEntrances(found, {}).unclassified).toEqual([RUNTIME_ENTRANCE.path])
  })

  it('passes a classified entrance, and flags an inventory entry that no longer exists', () => {
    const inventory = { [RUNTIME_ENTRANCE.path]: 'reason', 'src/gone.ts': 'reason' }
    expect(classifyTurnEntrances([RUNTIME_ENTRANCE.path], inventory)).toEqual({
      unclassified: [],
      stale: ['src/gone.ts']
    })
  })

  it('recognises the channel and the preload call, not only the runner', () => {
    expect(
      findTurnEntrances([
        { path: 'src/preload/x.ts', source: "ipcRenderer.invoke('conversations:sendTurn', a)" },
        { path: 'mobile/src/y.ts', source: 'await api.conversations.sendTurn({ id })' }
      ])
    ).toEqual(['mobile/src/y.ts', 'src/preload/x.ts'])
  })
})

describe('stripComments', () => {
  it('keeps code that merely sits next to a comment', () => {
    expect(stripComments('const a = 1 // process.cwd()\nconst b = process.cwd()')).toContain(
      'const b = process.cwd()'
    )
  })

  it('does not treat a url as a line comment', () => {
    expect(stripComments('const u = "https://example.com/x"')).toContain('https://example.com/x')
  })
})
