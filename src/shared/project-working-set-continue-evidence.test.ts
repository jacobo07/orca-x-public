import { describe, expect, it } from 'vitest'
import {
  continueCwdByPaneKey,
  continueEvidenceOnTarget
} from './project-working-set-continue-evidence'
import { leafId, representativeManifest } from './project-working-set-test-fixtures'
import type { WorkingSetRestoreEvidence } from './project-working-set-store-types'

const KEY_A = `tab-a:${leafId(1)}`
const KEY_C = `tab-c:${leafId(3)}`

function sourceEvidence(): WorkingSetRestoreEvidence {
  return {
    location: 'present',
    startupCwdByTabId: {},
    panes: {
      [KEY_A]: { sealedScrollback: 'absent', transcript: 'present' },
      [KEY_C]: { sealedScrollback: 'present', transcript: null }
    }
  }
}

describe('continueEvidenceOnTarget', () => {
  it('drops a transcript seen only on the source to unknown', () => {
    const out = continueEvidenceOnTarget(sourceEvidence(), null)
    expect(out?.panes[KEY_A].transcript).toBe('unknown')
    expect(out?.panes[KEY_C]).toEqual({ sealedScrollback: 'present', transcript: null })
  })

  it('keeps present only for a copy read back on the target', () => {
    const copied = continueEvidenceOnTarget(sourceEvidence(), {
      [KEY_A]: { transcript: 'present', reason: 'copied' }
    })
    expect(copied?.panes[KEY_A].transcript).toBe('present')
    const failed = continueEvidenceOnTarget(sourceEvidence(), {
      [KEY_A]: { transcript: 'unknown', reason: 'write-failed' }
    })
    expect(failed?.panes[KEY_A].transcript).toBe('unknown')
  })

  it('passes absent evidence through as absent', () => {
    expect(continueEvidenceOnTarget(null, null)).toBeNull()
  })
})

describe('continueCwdByPaneKey', () => {
  it('names the startup cwd, or the workspace root, of each provider pane only', () => {
    const manifest = representativeManifest()
    manifest.scope.location = {
      kind: 'repo-worktree',
      repoId: 'repo-9',
      worktreePath: '/srv/orca'
    }
    manifest.entries[0].startupCwd = '/srv/orca/packages/app'
    const cwds = continueCwdByPaneKey(manifest)
    expect(cwds[KEY_A]).toBe('/srv/orca/packages/app')
    expect(cwds[`tab-b:${leafId(2)}`]).toBe('/srv/orca')
    expect(cwds[KEY_C]).toBeUndefined()
  })
})
