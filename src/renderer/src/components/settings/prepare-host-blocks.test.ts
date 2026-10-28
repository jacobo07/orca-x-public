import { describe, expect, it } from 'vitest'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import { selectPrepareHostBlocks } from './prepare-host-blocks'

function setup(overrides: Partial<ProjectHostSetup>): ProjectHostSetup {
  return {
    id: 's1',
    projectId: 'p1',
    hostId: 'local',
    repoId: 'r1',
    path: '/work/orca',
    displayName: 'orca',
    setupState: 'ready',
    setupMethod: 'existing-folder',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as ProjectHostSetup
}

const REPO = { id: 'r1', connectionId: null, executionHostId: null }

describe('selectPrepareHostBlocks', () => {
  it('falls back to the repo itself when the project has no host setups', () => {
    const blocks = selectPrepareHostBlocks({ repo: REPO, setups: [] })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ key: 'r1', repoId: 'r1', target: { kind: 'local' } })
  })

  it('makes one block per owning host and targets a runtime host by its environment', () => {
    const blocks = selectPrepareHostBlocks({
      repo: REPO,
      setups: [
        setup({ id: 's1', repoId: 'r1' }),
        setup({ id: 's2', repoId: 'r2', hostId: 'runtime:env-9' as ProjectHostSetup['hostId'] })
      ]
    })
    expect(blocks.map((block) => block.key)).toEqual(['s1', 's2'])
    expect(blocks[1].target).toEqual({ kind: 'environment', environmentId: 'env-9' })
    expect(blocks[1].repoId).toBe('r2')
  })

  it('skips a setup that has no repo yet and keeps the selected one when two share a host', () => {
    const blocks = selectPrepareHostBlocks({
      repo: REPO,
      setups: [
        setup({ id: 's1', repoId: 'r1' }),
        setup({ id: 's3', repoId: 'r3' }),
        setup({ id: 's4', repoId: '', hostId: 'ssh:t1' as ProjectHostSetup['hostId'] })
      ],
      selectedSetupId: 's3'
    })
    expect(blocks.map((block) => block.key)).toEqual(['s3'])
  })
})
