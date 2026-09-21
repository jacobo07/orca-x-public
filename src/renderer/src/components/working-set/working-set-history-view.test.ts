import { describe, expect, it } from 'vitest'
import { representativeManifest } from '../../../../shared/project-working-set-test-fixtures'
import { projectWorkingSetHistory } from './working-set-history-view'

const OTHER_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

function manifests() {
  const first = { ...representativeManifest(), label: 'Morning', createdAt: 200 }
  const second = { ...first, workingSetId: OTHER_ID, createdAt: 100 }
  return [first, second]
}

describe('projectWorkingSetHistory', () => {
  it('keeps unavailable apart from an empty store', () => {
    expect(projectWorkingSetHistory({ status: 'unavailable' })).toEqual({ kind: 'unavailable' })
    expect(
      projectWorkingSetHistory({
        status: 'listed',
        valid: [],
        latestWorkingSetId: null,
        problems: [],
        tempArtifactCount: 0
      })
    ).toEqual({ kind: 'listed', rows: [], problems: [] })
  })

  it('names an unreadable store and a malformed request separately', () => {
    expect(projectWorkingSetHistory({ status: 'unreadable', code: 'EACCES' })).toEqual({
      kind: 'unreadable',
      code: 'EACCES'
    })
    expect(projectWorkingSetHistory({ status: 'invalid-request', field: 'scope' })).toEqual({
      kind: 'invalid-request'
    })
  })

  it('keeps two snapshots with the same label as two rows, in store order', () => {
    const [first, second] = manifests()
    const view = projectWorkingSetHistory({
      status: 'listed',
      valid: [first, second],
      latestWorkingSetId: first.workingSetId,
      problems: [],
      tempArtifactCount: 0
    })
    expect(view.kind === 'listed' && view.rows).toEqual([
      {
        workingSetId: first.workingSetId,
        label: 'Morning',
        createdAt: 200,
        tabCount: first.entries.length,
        isLatest: true
      },
      {
        workingSetId: OTHER_ID,
        label: 'Morning',
        createdAt: 100,
        tabCount: second.entries.length,
        isLatest: false
      }
    ])
  })

  it('lists unreadable entries by what the store proved, never as missing history', () => {
    const view = projectWorkingSetHistory({
      status: 'listed',
      valid: [],
      latestWorkingSetId: null,
      problems: [
        { workingSetId: 'a', outcome: { status: 'unsupported-version', manifestVersion: 9 } },
        { workingSetId: 'b', outcome: { status: 'corrupt', reason: 'shape', detail: 'x' } },
        { workingSetId: 'c', outcome: { status: 'unreadable', code: 'EIO' } },
        { workingSetId: 'd', outcome: { status: 'unverified' } },
        { fileName: 'stray.json', outcome: { status: 'unrecognized' } }
      ],
      tempArtifactCount: 1
    })
    expect(view.kind === 'listed' && view.problems.map((p) => [p.workingSetId, p.kind])).toEqual([
      ['a', 'unsupported-version'],
      ['b', 'corrupt'],
      ['c', 'unreadable'],
      ['d', 'unverified'],
      [null, 'unrecognized']
    ])
  })
})
