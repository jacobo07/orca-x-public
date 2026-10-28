import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  HYDRATED_SETUP_MAX_AGE_MS,
  hydratedAddressesForProject,
  taskDependencies,
  type ProjectSetupClaim
} from './mission-job-locality'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

function claim(
  projectId: string,
  hostId: ProjectSetupClaim['hostId'],
  setupState: ProjectSetupClaim['setupState'],
  updatedAt = NOW
): ProjectSetupClaim {
  return { projectId, hostId, setupState, updatedAt }
}

describe('hydratedAddressesForProject', () => {
  it('returns only the ready setups of the named project', () => {
    const setups = [
      claim('P', 'runtime:b', 'ready'),
      claim('Q', 'runtime:a', 'ready'),
      claim('P', 'local', 'ready')
    ]
    expect(hydratedAddressesForProject('P', setups, NOW).sort()).toEqual(['local', 'runtime:b'])
    expect(hydratedAddressesForProject('Q', setups, NOW)).toEqual(['runtime:a'])
  })

  it('is empty for an empty registry and for a project nobody holds', () => {
    expect(hydratedAddressesForProject('P', [], NOW)).toEqual([])
    expect(hydratedAddressesForProject('Z', [claim('P', 'local', 'ready')], NOW)).toEqual([])
  })

  it('counts a setup in any state other than ready as not hydrated', () => {
    for (const state of ['not-set-up', 'setting-up', 'error', 'unsupported'] as const) {
      expect(hydratedAddressesForProject('P', [claim('P', 'runtime:b', state)], NOW)).toEqual([])
    }
    expect(hydratedAddressesForProject('P', [claim('P', 'runtime:b', 'ready')], NOW)).toEqual([
      'runtime:b'
    ])
  })

  it('lists a host once however many ready setups name it', () => {
    const setups = [claim('P', 'runtime:b', 'ready'), claim('P', 'runtime:b', 'ready')]
    expect(hydratedAddressesForProject('P', setups, NOW)).toEqual(['runtime:b'])
  })

  it('keeps the window at 7 days', () => {
    expect(HYDRATED_SETUP_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('counts a ready setup inside the window as hydrated and an older one as not', () => {
    const fresh = claim('P', 'runtime:a', 'ready', NOW - DAY)
    const stale = claim('P', 'runtime:b', 'ready', NOW - 8 * DAY)
    expect(hydratedAddressesForProject('P', [fresh, stale], NOW)).toEqual(['runtime:a'])
  })

  it('treats exactly 7 days as fresh and one millisecond more as stale', () => {
    const edge = HYDRATED_SETUP_MAX_AGE_MS
    expect(
      hydratedAddressesForProject('P', [claim('P', 'local', 'ready', NOW - edge)], NOW)
    ).toEqual(['local'])
    expect(
      hydratedAddressesForProject('P', [claim('P', 'local', 'ready', NOW - edge - 1)], NOW)
    ).toEqual([])
  })

  it('treats a missing or non-finite update time as not hydrated', () => {
    for (const updatedAt of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const setup = { ...claim('P', 'runtime:b', 'ready'), updatedAt } as ProjectSetupClaim
      expect(hydratedAddressesForProject('P', [setup], NOW)).toEqual([])
    }
  })

  it('treats an update time in the future (clock skew) as fresh', () => {
    expect(
      hydratedAddressesForProject('P', [claim('P', 'runtime:b', 'ready', NOW + DAY)], NOW)
    ).toEqual(['runtime:b'])
  })

  it('reads the injected clock, not the wall clock', () => {
    const setup = claim('P', 'runtime:b', 'ready', 1_000)
    expect(hydratedAddressesForProject('P', [setup], 1_000 + DAY)).toEqual(['runtime:b'])
    expect(hydratedAddressesForProject('P', [setup], 1_000 + 30 * DAY)).toEqual([])
  })

  it('carries the setup time in its input type', () => {
    expectTypeOf<keyof ProjectSetupClaim>().toEqualTypeOf<
      'projectId' | 'hostId' | 'setupState' | 'updatedAt'
    >()
  })
})

describe('taskDependencies', () => {
  it('returns the ids of a valid array of strings, in order', () => {
    expect(taskDependencies('["a","b"]')).toEqual(['a', 'b'])
  })

  it('returns an empty list for an empty array', () => {
    expect(taskDependencies('[]')).toEqual([])
  })

  it('returns an empty list, without throwing, for text that is not JSON', () => {
    for (const text of ['', 'not json', '[', '{"a":1']) {
      expect(() => taskDependencies(text)).not.toThrow()
      expect(taskDependencies(text)).toEqual([])
    }
  })

  it('returns an empty list for JSON that is not an array', () => {
    for (const text of ['{}', '"a"', '7', 'null', 'true', '{"0":"a"}']) {
      expect(taskDependencies(text)).toEqual([])
    }
  })

  it('returns an empty list when any element is not a string', () => {
    for (const text of ['["a",1]', '[null]', '[["a"]]', '[{"id":"a"}]', '["a",true]']) {
      expect(taskDependencies(text)).toEqual([])
    }
  })

  it('returns an empty list for null or undefined text', () => {
    expect(taskDependencies(null)).toEqual([])
    expect(taskDependencies(undefined)).toEqual([])
  })
})
