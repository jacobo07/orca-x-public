import { describe, expect, it } from 'vitest'
import type { ProjectHostSetupWithReplicaTopology } from '../../shared/replica-topology'
import { RuntimeClientError } from '../runtime/types'
import {
  FAN_OUT_ERROR_CODE_OUTCOMES,
  listSetupsAcrossEnvironments,
  type FanOutClient,
  type FanOutEnvironment,
  type FanOutEntry
} from './project-setups-all-environments'

const ROOT_PROJECT_ID = `git-root:${'a'.repeat(40)}`
// Why: stands in for any text an error message might carry; it must never reach the output.
const LEAK_PROBE = 'probe-7c1f-must-not-appear'

function setup(
  id: string,
  options: { kind?: 'git' | 'folder'; topology?: boolean } = {}
): ProjectHostSetupWithReplicaTopology {
  const kind = options.kind ?? 'git'
  const projectId = kind === 'folder' ? `repo:${id}` : ROOT_PROJECT_ID
  return {
    id,
    projectId,
    hostId: 'local',
    repoId: id,
    path: `/srv/${id}`,
    displayName: id,
    kind,
    setupState: 'ready',
    setupMethod: 'cloned',
    createdAt: 1,
    updatedAt: 1,
    ...(options.topology === false
      ? {}
      : {
          replicaTopology: {
            setupId: id,
            projectId,
            hostId: 'local' as const,
            path: `/srv/${id}`,
            provenance: 'cloned' as const,
            membership: kind === 'folder' ? ('host-local' as const) : ('grouped' as const),
            relation: 'unverified' as const
          }
        })
  }
}

function env(name: string, runtimeId: string | null = null): FanOutEnvironment {
  return { id: `env-${name}`, name, runtimeId }
}

type Behavior =
  | { runtimeId: string; setups: ProjectHostSetupWithReplicaTopology[] }
  | { throws: unknown }
  | { never: true }

// Why: the fake records every call so the tests can prove the fan-out only ever asks the one method.
function harness(environments: FanOutEnvironment[], behaviors: Record<string, Behavior>) {
  const callLog: { selector: string; method: string }[] = []
  const factoryLog: string[] = []
  const deps = {
    listEnvironments: () => environments,
    createClient: (selector: string, _timeoutMs: number): FanOutClient => {
      factoryLog.push(selector)
      return {
        call: async (method: string) => {
          callLog.push({ selector, method })
          const behavior = behaviors[selector]
          if (!behavior) {
            throw new Error(`no behavior for ${selector}`)
          }
          if ('throws' in behavior) {
            throw behavior.throws
          }
          if ('never' in behavior) {
            return await new Promise<never>(() => {})
          }
          return {
            id: 'r',
            ok: true as const,
            result: { setups: behavior.setups },
            _meta: { runtimeId: behavior.runtimeId }
          }
        }
      } as unknown as FanOutClient
    },
    timeoutMs: 40
  }
  return { deps, callLog, factoryLog }
}

function entryFor(entries: readonly FanOutEntry[], environment: string): FanOutEntry {
  const entry = entries.find((candidate) => candidate.environment === environment)
  if (!entry) {
    throw new Error(`no entry for ${environment}`)
  }
  return entry
}

describe('listSetupsAcrossEnvironments', () => {
  it('lists each reachable runtime with its runtime id and keeps the same setup id on two runtimes as two entries', async () => {
    const { deps } = harness([env('alpha'), env('beta')], {
      'env-alpha': { runtimeId: 'rt-a', setups: [setup('shared'), setup('only-a')] },
      'env-beta': { runtimeId: 'rt-b', setups: [setup('shared')] }
    })

    const listing = await listSetupsAcrossEnvironments(deps)

    expect(listing.status).toBe('queried')
    expect(listing.entries.map((entry) => entry.outcome)).toEqual(['answered', 'answered'])
    const alpha = entryFor(listing.entries, 'alpha')
    const beta = entryFor(listing.entries, 'beta')
    expect(alpha.outcome === 'answered' && alpha.runtimeId).toBe('rt-a')
    expect(alpha.outcome === 'answered' && alpha.setups.map((s) => s.id)).toEqual([
      'shared',
      'only-a'
    ])
    expect(beta.outcome === 'answered' && beta.setups.map((s) => s.id)).toEqual(['shared'])
    expect(listing.entries.filter((entry) => entry.outcome !== 'answered')).toEqual([])
  })

  describe.each([...FAN_OUT_ERROR_CODE_OUTCOMES.entries()])(
    'error code %s',
    (code, expectedOutcome) => {
      it(`is its own ${expectedOutcome} entry, never dropped and never an empty answer`, async () => {
        const { deps } = harness([env('up'), env('down')], {
          'env-up': { runtimeId: 'rt-up', setups: [setup('s1')] },
          'env-down': { throws: new RuntimeClientError(code, `boom ${LEAK_PROBE}`) }
        })

        const listing = await listSetupsAcrossEnvironments(deps)

        const down = entryFor(listing.entries, 'down')
        expect(down.outcome).toBe(expectedOutcome)
        expect(down).not.toHaveProperty('setups')
        expect(JSON.stringify(listing)).not.toContain(LEAK_PROBE)
        // Control: the healthy neighbour is still answered.
        expect(entryFor(listing.entries, 'up').outcome).toBe('answered')
        expect(listing.entries).toHaveLength(2)
      })
    }
  )

  it('lists any other error as failed with its code only, never the message', async () => {
    const { deps } = harness([env('odd')], {
      'env-odd': { throws: new RuntimeClientError('invalid_runtime_response', LEAK_PROBE) }
    })

    const listing = await listSetupsAcrossEnvironments(deps)

    const odd = entryFor(listing.entries, 'odd')
    expect(odd).toMatchObject({ outcome: 'failed', code: 'invalid_runtime_response' })
    expect(JSON.stringify(listing)).not.toContain(LEAK_PROBE)
  })

  it('does not echo a code that a remote host made up with control characters', async () => {
    const { deps } = harness([env('odd'), env('plain')], {
      'env-odd': { throws: new RuntimeClientError('\u001b[31mred\u001b[0m', 'x') },
      'env-plain': { throws: new Error(`plain ${LEAK_PROBE}`) }
    })

    const listing = await listSetupsAcrossEnvironments(deps)

    expect(entryFor(listing.entries, 'odd')).toMatchObject({
      outcome: 'failed',
      code: 'unknown_error'
    })
    expect(entryFor(listing.entries, 'plain')).toMatchObject({
      outcome: 'failed',
      code: 'unknown_error'
    })
    expect(JSON.stringify(listing)).not.toContain(LEAK_PROBE)
    expect(JSON.stringify(listing)).not.toContain('\\u001b')
  })

  it('lists an old host that reports no topology with its setups, not as having no replicas', async () => {
    const { deps } = harness([env('old')], {
      'env-old': {
        runtimeId: 'rt-old',
        setups: [setup('legacy', { topology: false }), setup('folder', { kind: 'folder' })]
      }
    })

    const listing = await listSetupsAcrossEnvironments(deps)

    const old = entryFor(listing.entries, 'old')
    expect(old.outcome).toBe('answered')
    if (old.outcome !== 'answered') {
      throw new Error('unreachable')
    }
    expect(old.setups).toHaveLength(2)
    expect(old.setups[0].replicaTopology).toBeUndefined()
    // Folder-kind setups ride through unchanged (AGENTS.md: folder workspaces).
    expect(old.setups[1].kind).toBe('folder')
  })

  it('lists one runtime reached through two environments once, with both names', async () => {
    const { deps } = harness([env('first'), env('second'), env('third')], {
      'env-first': { runtimeId: 'rt-same', setups: [setup('a'), setup('b')] },
      'env-second': { runtimeId: 'rt-same', setups: [setup('a'), setup('b')] },
      'env-third': { runtimeId: 'rt-other', setups: [setup('a')] }
    })

    const listing = await listSetupsAcrossEnvironments(deps)

    expect(listing.entries).toHaveLength(2)
    const first = entryFor(listing.entries, 'first')
    expect(first).toMatchObject({ outcome: 'answered', runtimeId: 'rt-same' })
    expect(first.outcome === 'answered' && first.alsoReachedAs).toEqual(['second'])
    expect(first.outcome === 'answered' && first.setups.map((s) => s.id)).toEqual(['a', 'b'])
    // Control: a different runtime with the same setup id is not merged.
    expect(entryFor(listing.entries, 'third')).toMatchObject({
      outcome: 'answered',
      runtimeId: 'rt-other'
    })
  })

  it('reports zero saved environments as an explicit result, not an empty success', async () => {
    const { deps, factoryLog } = harness([], {})

    const listing = await listSetupsAcrossEnvironments(deps)

    expect(listing).toEqual({ status: 'no-saved-environments', entries: [], queried: [] })
    expect(factoryLog).toEqual([])
  })

  it('asks only projectHostSetup.list, once per environment', async () => {
    const { deps, callLog } = harness([env('a'), env('b'), env('c')], {
      'env-a': { runtimeId: 'rt-a', setups: [] },
      'env-b': { throws: new RuntimeClientError('unauthorized', 'no') },
      'env-c': { runtimeId: 'rt-c', setups: [setup('x')] }
    })

    await listSetupsAcrossEnvironments(deps)

    expect(callLog.map((call) => call.method)).toEqual([
      'projectHostSetup.list',
      'projectHostSetup.list',
      'projectHostSetup.list'
    ])
    expect(callLog.map((call) => call.selector).sort()).toEqual(['env-a', 'env-b', 'env-c'])
  })

  it('names every queried environment, answered or not', async () => {
    const { deps } = harness([env('a'), env('b')], {
      'env-a': { runtimeId: 'rt-a', setups: [] },
      'env-b': { throws: new RuntimeClientError('runtime_timeout', 'slow') }
    })

    const listing = await listSetupsAcrossEnvironments(deps)

    expect(listing.queried).toEqual(['a', 'b'])
  })

  it('does not let one slow runtime delay or reject the others', async () => {
    const { deps } = harness([env('slow'), env('fast')], {
      'env-slow': { never: true },
      'env-fast': { runtimeId: 'rt-fast', setups: [setup('f')] }
    })

    const startedAt = Date.now()
    const listing = await listSetupsAcrossEnvironments(deps)

    expect(Date.now() - startedAt).toBeLessThan(2000)
    expect(entryFor(listing.entries, 'slow').outcome).toBe('unreachable')
    expect(entryFor(listing.entries, 'fast').outcome).toBe('answered')
  })

  it('turns a failure to build the client into that environment’s own entry', async () => {
    const { deps } = harness([env('broken'), env('fine')], {
      'env-fine': { runtimeId: 'rt-fine', setups: [] }
    })
    const createClient = deps.createClient
    deps.createClient = (selector, timeoutMs) => {
      if (selector === 'env-broken') {
        throw new RuntimeClientError('invalid_argument', LEAK_PROBE)
      }
      return createClient(selector, timeoutMs)
    }

    const listing = await listSetupsAcrossEnvironments(deps)

    expect(entryFor(listing.entries, 'broken')).toMatchObject({
      outcome: 'failed',
      code: 'invalid_argument'
    })
    expect(entryFor(listing.entries, 'fine').outcome).toBe('answered')
    expect(JSON.stringify(listing)).not.toContain(LEAK_PROBE)
  })
})
