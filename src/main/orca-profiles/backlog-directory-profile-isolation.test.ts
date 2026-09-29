// The intent ledger is profile-scoped, proved by asking the service what each profile can SEE, not
// by reading the pathname.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BacklogService } from '../backlog/backlog-service'
import { getOrcaBacklogDirectory, getOrcaProfileDirectory } from './profile-storage-paths'

const PROFILE_A = 'profile-alpha'
const PROFILE_B = 'profile-beta'

let userDataPath = ''

function serviceFor(profileId: string): BacklogService {
  return new BacklogService(() => getOrcaBacklogDirectory(profileId, userDataPath))
}

beforeEach(() => {
  // The temp name carries no backlog id, so an absence assertion cannot be satisfied by the path.
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-ledger-profile-'))
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('backlog directory profile isolation', () => {
  it('cannot read another profile’s item even when handed its id', async () => {
    const captured = await serviceFor(PROFILE_A).capture({ text: 'alpha intent', kind: 'idea' })
    if (captured.outcome !== 'published') {
      throw new Error(`capture did not publish: ${captured.outcome}`)
    }

    // Positive control FIRST: a service that reads nothing would satisfy the absence below.
    expect((await serviceFor(PROFILE_A).get(captured.record.id)).outcome).toBe('loaded')
    expect(await serviceFor(PROFILE_B).get(captured.record.id)).toEqual({ outcome: 'absent' })
  })

  it('nests the backlog directory inside the profile it belongs to', () => {
    expect(getOrcaBacklogDirectory(PROFILE_A, userDataPath)).toContain(
      getOrcaProfileDirectory(PROFILE_A, userDataPath)
    )
    expect(getOrcaBacklogDirectory(PROFILE_A, userDataPath)).not.toEqual(
      getOrcaBacklogDirectory(PROFILE_B, userDataPath)
    )
  })
})
