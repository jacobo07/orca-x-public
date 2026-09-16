import { describe, expect, it, vi } from 'vitest'
import { representativeManifest } from '../../../shared/project-working-set-test-fixtures'
import {
  listWorkingSets,
  readWorkingSet,
  saveWorkingSetManifest,
  type WorkingSetStoreBridge
} from './project-working-set-client'

const scope = { executionHostId: 'local' as const, ownerKey: 'repo-1::C:/work/orca' }
const id = '6f1d3c1e-2b7a-4c1e-9a3b-0d5e8f7a6b21'

function bridge(answer: unknown): WorkingSetStoreBridge {
  const reply = vi.fn(async () => answer)
  return { save: reply, list: reply, read: reply }
}

describe('working-set store client', () => {
  it('reads what the name-guessing web fallback answers as unavailable, never as empty', async () => {
    // The browser fallback answers list* with [] and everything else with undefined.
    expect(await listWorkingSets(scope, bridge([]))).toEqual({ status: 'unavailable' })
    expect(await readWorkingSet(scope, id, bridge(undefined))).toEqual({ status: 'unavailable' })
    expect(await saveWorkingSetManifest(representativeManifest(), bridge(undefined))).toEqual({
      status: 'unavailable'
    })
  })

  it('treats a missing handler, a foreign status or a malformed listing as unavailable', async () => {
    const noHandler = vi.fn(async () => {
      throw new Error('No handler registered')
    })
    const rejecting: WorkingSetStoreBridge = { save: noHandler, list: noHandler, read: noHandler }
    expect(await listWorkingSets(scope, rejecting)).toEqual({ status: 'unavailable' })
    expect(await readWorkingSet(scope, id, bridge({ status: 'ok' }))).toEqual({
      status: 'unavailable'
    })
    expect(await listWorkingSets(scope, bridge({ status: 'listed' }))).toEqual({
      status: 'unavailable'
    })
  })

  it('passes every real answer through unchanged, including an empty store', async () => {
    const empty = {
      status: 'listed',
      valid: [],
      latestWorkingSetId: null,
      problems: [],
      tempArtifactCount: 0
    }
    expect(await listWorkingSets(scope, bridge(empty))).toEqual(empty)
    for (const answer of [
      { status: 'missing' },
      { status: 'unreadable', code: 'EACCES' },
      { status: 'invalid-request', field: 'workingSetId' },
      { status: 'valid', manifest: representativeManifest() }
    ]) {
      expect(await readWorkingSet(scope, id, bridge(answer))).toEqual(answer)
    }
    expect(await listWorkingSets(scope, bridge({ status: 'unavailable' }))).toEqual({
      status: 'unavailable'
    })
  })
})
