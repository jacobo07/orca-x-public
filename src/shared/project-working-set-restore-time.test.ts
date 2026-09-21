import { describe, expect, it } from 'vitest'
import {
  classifyRestoreTimeCapability,
  type RestoreTimeInputs
} from './project-working-set-restore-time'
import type {
  WorkingSetFactPresence,
  WorkingSetRestoreEvidence
} from './project-working-set-store-types'
import { entryOf, leafId, representativeManifest } from './project-working-set-test-fixtures'

const PROFILES = [{ id: 'agent:claude' }, { id: 'agent:codex' }, { id: 'shell:wsl.exe' }]

type PaneFacts = { transcript?: WorkingSetFactPresence | null; scrollback?: WorkingSetFactPresence }

function evidence(
  location: WorkingSetFactPresence,
  panes: Record<string, PaneFacts> = {},
  cwd: WorkingSetFactPresence = 'present'
): WorkingSetRestoreEvidence {
  const manifest = representativeManifest()
  return {
    location,
    startupCwdByTabId: { 'tab-d': cwd },
    panes: Object.fromEntries(
      manifest.entries.map((entry) => {
        const pane = entry.panes[0]
        const given = panes[entry.tabId] ?? {}
        const provider = pane.resume.kind === 'provider-session'
        return [
          `${entry.tabId}:${pane.leafId}`,
          {
            sealedScrollback: given.scrollback ?? 'absent',
            transcript: provider ? (given.transcript ?? 'present') : null
          }
        ]
      })
    )
  }
}

function classify(tabId: string, inputs: RestoreTimeInputs) {
  const entry = entryOf(representativeManifest(), tabId)
  return classifyRestoreTimeCapability(entry, entry.panes[0], inputs)
}

const confirmed: RestoreTimeInputs = { evidence: evidence('present'), launchProfiles: PROFILES }

describe('classifyRestoreTimeCapability', () => {
  it('confirms each captured verdict when today agrees with it', () => {
    expect(classify('tab-a', confirmed)).toEqual({
      capability: 'exact-resume',
      captured: 'exact-resume',
      history: 'absent',
      reasons: []
    })
    expect(classify('tab-c', confirmed).capability).toBe('restartable')
    expect(classify('tab-d', confirmed).capability).toBe('recreate-context')
    expect(classify('tab-e', confirmed)).toMatchObject({
      capability: 'unknown',
      reasons: ['launch-unknown']
    })
  })

  it('downgrades a captured exact resume whose transcript was proven deleted', () => {
    const inputs = {
      ...confirmed,
      evidence: evidence('present', { 'tab-a': { transcript: 'absent' } })
    }
    expect(classify('tab-a', inputs)).toEqual({
      capability: 'restartable',
      captured: 'exact-resume',
      history: 'absent',
      reasons: ['provider-session-gone']
    })
  })

  it('does not call an unconfirmed resume exact, and does not call it anything else either', () => {
    const inputs = {
      ...confirmed,
      evidence: evidence('present', { 'tab-a': { transcript: 'unknown' } })
    }
    expect(classify('tab-a', inputs)).toMatchObject({
      capability: 'unknown',
      captured: 'exact-resume',
      reasons: ['resume-unconfirmed']
    })
    const noProbe = classify('tab-a', { evidence: null, launchProfiles: PROFILES })
    expect(noProbe).toMatchObject({
      capability: 'unknown',
      history: 'unknown',
      reasons: ['evidence-unavailable', 'location-unconfirmed']
    })
  })

  it('keeps a relaunchable pane unknown while its location or profiles are unconfirmed', () => {
    expect(classify('tab-c', { ...confirmed, evidence: evidence('unknown') })).toMatchObject({
      capability: 'unknown',
      reasons: ['location-unconfirmed']
    })
    expect(classify('tab-c', { ...confirmed, launchProfiles: null })).toMatchObject({
      capability: 'unknown',
      reasons: ['launch-profile-unconfirmed']
    })
  })

  it('shows history when execution is gone but the sealed copy survives', () => {
    const gone = evidence('absent', { 'tab-a': { scrollback: 'present' } })
    expect(classify('tab-a', { ...confirmed, evidence: gone })).toMatchObject({
      capability: 'history-only',
      reasons: ['location-missing']
    })
    const conversationGone = evidence('present', {
      'tab-e': { scrollback: 'present' },
      'tab-a': { transcript: 'absent', scrollback: 'present' }
    })
    // Launch evidence unknown and conversation gone: the history is what remains.
    const entry = entryOf(representativeManifest(), 'tab-a')
    entry.launch = { launchProfileId: null, launchAgent: null, shellOverride: null }
    expect(
      classifyRestoreTimeCapability(entry, entry.panes[0], {
        ...confirmed,
        evidence: conversationGone
      })
    ).toMatchObject({
      capability: 'history-only',
      reasons: ['provider-session-gone', 'launch-unknown']
    })
    // A pane whose capture was merely unknown is not proven unrunnable by having history.
    expect(classify('tab-e', { ...confirmed, evidence: conversationGone }).capability).toBe(
      'unknown'
    )
  })

  it('calls a pane not restorable only on positive evidence', () => {
    expect(classify('tab-c', { ...confirmed, evidence: evidence('absent') })).toMatchObject({
      capability: 'not-restorable',
      reasons: ['location-missing']
    })
    expect(
      classify('tab-c', { ...confirmed, launchProfiles: [{ id: 'agent:claude' }] })
    ).toMatchObject({ capability: 'not-restorable', reasons: ['launch-profile-missing'] })
    expect(classify('tab-e', { ...confirmed, evidence: evidence('unknown') }).capability).toBe(
      'unknown'
    )
  })

  it('keeps a recreatable pane recreatable when only its launch directory is gone, and says so', () => {
    expect(
      classify('tab-d', { ...confirmed, evidence: evidence('present', {}, 'absent') })
    ).toEqual({
      capability: 'recreate-context',
      captured: 'recreate-context',
      history: 'absent',
      reasons: ['startup-cwd-missing']
    })
  })

  it('classifies a split pane the tab did not launch as unknown', () => {
    const entry = entryOf(representativeManifest(), 'tab-c')
    entry.panes = [...entry.panes, { ...entry.panes[0], leafId: leafId(7) }]
    expect(classifyRestoreTimeCapability(entry, entry.panes[1], confirmed).capability).toBe(
      'unknown'
    )
  })
})
