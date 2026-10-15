import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  hydratedAddressesForProject,
  taskDependencies,
  type ProjectSetupClaim
} from './mission-job-locality'

function claim(
  projectId: string,
  hostId: ProjectSetupClaim['hostId'],
  setupState: ProjectSetupClaim['setupState']
): ProjectSetupClaim {
  return { projectId, hostId, setupState }
}

describe('hydratedAddressesForProject', () => {
  it('returns only the ready setups of the named project', () => {
    const setups = [
      claim('P', 'runtime:b', 'ready'),
      claim('Q', 'runtime:a', 'ready'),
      claim('P', 'local', 'ready')
    ]
    expect(hydratedAddressesForProject('P', setups).sort()).toEqual(['local', 'runtime:b'])
    expect(hydratedAddressesForProject('Q', setups)).toEqual(['runtime:a'])
  })

  it('is empty for an empty registry and for a project nobody holds', () => {
    expect(hydratedAddressesForProject('P', [])).toEqual([])
    expect(hydratedAddressesForProject('Z', [claim('P', 'local', 'ready')])).toEqual([])
  })

  it('counts a setup in any state other than ready as not hydrated', () => {
    for (const state of ['not-set-up', 'setting-up', 'error', 'unsupported'] as const) {
      expect(hydratedAddressesForProject('P', [claim('P', 'runtime:b', state)])).toEqual([])
    }
    expect(hydratedAddressesForProject('P', [claim('P', 'runtime:b', 'ready')])).toEqual([
      'runtime:b'
    ])
  })

  it('lists a host once however many ready setups name it', () => {
    const setups = [claim('P', 'runtime:b', 'ready'), claim('P', 'runtime:b', 'ready')]
    expect(hydratedAddressesForProject('P', setups)).toEqual(['runtime:b'])
  })

  it('does not read the setup update time: a full setup record gives the same answer at any updatedAt', () => {
    const base = { projectId: 'P', hostId: 'runtime:b' as const, setupState: 'ready' as const }
    for (const updatedAt of [0, 1, Date.now()]) {
      const full = { ...base, updatedAt }
      expect(hydratedAddressesForProject('P', [full])).toEqual(['runtime:b'])
    }
  })

  it('has no field for a setup time in its input type', () => {
    expectTypeOf<keyof ProjectSetupClaim>().toEqualTypeOf<'projectId' | 'hostId' | 'setupState'>()
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
