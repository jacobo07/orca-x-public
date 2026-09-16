import type {
  ProjectWorkingSetManifest,
  WorkingSetEntry,
  WorkingSetPane
} from './project-working-set-types'

export const WORKING_SET_ID = '0f8c6a52-3b1e-4d7a-9c2e-5a1b2c3d4e5f'
export const SHARED_LABEL = 'Orca X — Claude'

export function leafId(n: number): string {
  return `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`
}

function pane(n: number, resume: WorkingSetPane['resume']): WorkingSetPane {
  return { leafId: leafId(n), title: null, scrollbackRef: `scrollback-${n}`, resume }
}

function entry(
  tabId: string,
  overrides: Partial<WorkingSetEntry> & Pick<WorkingSetEntry, 'panes' | 'restorePolicy'>
): WorkingSetEntry {
  return {
    tabId,
    label: `Terminal ${tabId}`,
    color: null,
    isPinned: false,
    launch: { launchProfileId: null, launchAgent: null, shellOverride: null },
    startupCwd: null,
    activeLeafId: overrides.panes[0]?.leafId ?? null,
    ...overrides
  }
}

/**
 * The working set the feature exists for: two rows sharing one title, a rail order that is neither
 * creation nor alphabetical order, a revival order that disagrees with it, every policy, every
 * capture-time capability, and an active row that stays dormant.
 */
export function representativeManifest(): ProjectWorkingSetManifest {
  return {
    manifestVersion: 1,
    workingSetId: WORKING_SET_ID,
    label: 'Antes de Minecraft',
    createdAt: 1_789_000_000_000,
    scope: {
      executionHostId: 'local',
      ownerKey: 'repo-1::C:/work/orca',
      location: { kind: 'repo-worktree', repoId: 'repo-1', worktreePath: 'C:/work/orca' }
    },
    railGroups: [
      ['tab-b', 'tab-e', 'tab-a'],
      ['tab-d', 'tab-c']
    ],
    revivalOrder: ['tab-a', 'tab-b'],
    activeTabId: 'tab-e',
    entries: [
      entry('tab-a', {
        label: SHARED_LABEL,
        isPinned: true,
        launch: { launchProfileId: null, launchAgent: 'claude', shellOverride: null },
        restorePolicy: 'auto-restore',
        panes: [
          pane(1, {
            kind: 'provider-session',
            agent: 'claude',
            providerSession: { key: 'session_id', id: 'claude-session-a' },
            ompResumeFilePath: null
          })
        ]
      }),
      entry('tab-b', {
        label: SHARED_LABEL,
        launch: { launchProfileId: null, launchAgent: 'claude', shellOverride: null },
        restorePolicy: 'auto-restore',
        panes: [
          pane(2, {
            kind: 'provider-session',
            agent: 'claude',
            providerSession: { key: 'session_id', id: 'claude-session-b' },
            ompResumeFilePath: null
          })
        ]
      }),
      entry('tab-c', {
        launch: { launchProfileId: null, launchAgent: 'codex', shellOverride: null },
        restorePolicy: 'restore-on-open',
        panes: [pane(3, { kind: 'absent', reason: 'no-provider-session-captured' })]
      }),
      entry('tab-d', {
        launch: {
          launchProfileId: null,
          launchAgent: null,
          shellOverride: 'C:\\Windows\\System32\\wsl.exe'
        },
        startupCwd: 'C:/work/orca/packages/app',
        restorePolicy: 'keep-dormant',
        panes: [pane(4, { kind: 'absent', reason: 'not-an-agent' })]
      }),
      entry('tab-e', {
        restorePolicy: 'keep-dormant',
        panes: [pane(5, { kind: 'absent', reason: 'not-an-agent' })]
      }),
      entry('tab-f', {
        restorePolicy: 'do-not-restore',
        panes: [pane(6, { kind: 'absent', reason: 'not-an-agent' })]
      })
    ]
  }
}

export function entryOf(manifest: ProjectWorkingSetManifest, tabId: string): WorkingSetEntry {
  const found = manifest.entries.find((candidate) => candidate.tabId === tabId)
  if (!found) {
    throw new Error(`fixture has no entry ${tabId}`)
  }
  return found
}
