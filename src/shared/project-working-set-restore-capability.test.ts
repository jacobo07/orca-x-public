import { describe, expect, it } from 'vitest'
import { classifyCaptureTimeRestoreCapability } from './project-working-set-restore-capability'
import { entryOf, leafId, representativeManifest } from './project-working-set-test-fixtures'
import {
  agentProfileId,
  HOST_DEFAULT_SHELL_PROFILE_ID,
  userProfileId
} from './terminal-launch-profiles'
import type { WorkingSetEntry } from './project-working-set-types'

function classify(entry: WorkingSetEntry) {
  return classifyCaptureTimeRestoreCapability(entry, entry.panes[0])
}

function withLaunch(tabId: string, launch: Partial<WorkingSetEntry['launch']>): WorkingSetEntry {
  const entry = entryOf(representativeManifest(), tabId)
  return { ...entry, launch: { ...entry.launch, ...launch } }
}

describe('classifyCaptureTimeRestoreCapability', () => {
  it('classifies every row of the representative working set', () => {
    const manifest = representativeManifest()

    expect(
      Object.fromEntries(manifest.entries.map((entry) => [entry.tabId, classify(entry).capability]))
    ).toEqual({
      'tab-a': 'exact-resume',
      'tab-b': 'exact-resume',
      'tab-c': 'restartable',
      'tab-d': 'recreate-context',
      'tab-e': 'unknown',
      'tab-f': 'unknown'
    })
  })

  it('keeps an inferred shell apart from a recorded one', () => {
    expect(classify(entryOf(representativeManifest(), 'tab-d')).launchIdentity).toEqual({
      source: 'inferred',
      profileId: 'shell:wsl.exe'
    })
    expect(
      classify(withLaunch('tab-e', { launchProfileId: HOST_DEFAULT_SHELL_PROFILE_ID }))
    ).toEqual({
      capability: 'recreate-context',
      launchIdentity: { source: 'recorded', profileId: HOST_DEFAULT_SHELL_PROFILE_ID }
    })
  })

  it('never calls a fresh launch a resume', () => {
    for (const launchProfileId of [userProfileId('kclaude'), agentProfileId('codex')]) {
      expect(classify(withLaunch('tab-e', { launchProfileId })).capability).toBe('restartable')
    }
  })

  it('leaves a row that recorded nothing unknown rather than a default shell', () => {
    expect(classify(entryOf(representativeManifest(), 'tab-e'))).toEqual({
      capability: 'unknown',
      launchIdentity: { source: 'unknown' }
    })
  })

  it('does not guess at a profile namespace it does not know', () => {
    expect(classify(withLaunch('tab-e', { launchProfileId: 'mystery:x' })).capability).toBe(
      'unknown'
    )
  })

  it('does not attribute tab-level launch evidence to one pane of a split', () => {
    const shellTab = entryOf(representativeManifest(), 'tab-d')
    const split: WorkingSetEntry = {
      ...shellTab,
      panes: [
        ...shellTab.panes,
        {
          leafId: leafId(7),
          title: null,
          scrollbackRef: null,
          resume: { kind: 'absent', reason: 'not-an-agent' }
        }
      ]
    }

    for (const pane of split.panes) {
      expect(classifyCaptureTimeRestoreCapability(split, pane).capability).toBe('unknown')
    }
  })

  it('still resumes an exact session inside a split', () => {
    const agentTab = entryOf(representativeManifest(), 'tab-a')
    const split: WorkingSetEntry = {
      ...agentTab,
      panes: [
        ...agentTab.panes,
        {
          leafId: leafId(7),
          title: null,
          scrollbackRef: null,
          resume: { kind: 'absent', reason: 'not-an-agent' }
        }
      ]
    }

    expect(classifyCaptureTimeRestoreCapability(split, split.panes[0]).capability).toBe(
      'exact-resume'
    )
  })

  it('is independent of restore policy', () => {
    const entry = entryOf(representativeManifest(), 'tab-a')

    for (const restorePolicy of ['keep-dormant', 'do-not-restore'] as const) {
      expect(classify({ ...entry, restorePolicy }).capability).toBe('exact-resume')
    }
  })
})
