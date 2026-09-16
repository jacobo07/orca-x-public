import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots, registerRuntimeTerminalTab } from './sync-runtime-graph'
import { makeState } from './sync-runtime-graph-test-harness'
import { resolveTerminalLaunchProfileIdentity } from '../../../shared/terminal-launch-profile-identity'
import type { AppState } from '../store/types'

// Wave 2, launch-profile lineage. The question is not whether mobile can GUESS which
// profile a terminal came from -- it already guesses well, preferring launchAgent over
// a title glyph. It is whether the recorded answer survives the trip.
//
// launchProfileId is the only field that yields source:'recorded'. It lives on
// TerminalTab and in the persisted session schema, and it is dropped HERE, where the
// renderer builds the row it publishes -- one boundary earlier than the parity ledger
// recorded, which named the host projection. Fixing only the host would have carried a
// field the host never receives.
//
// Every profile id below is chosen so that inference CANNOT produce it. The tab also
// carries launchAgent: 'claude', from which inference yields 'agent:claude'. So a row
// that reports 'shell:git-bash-ops' can only have got it from the recorded field, and a
// fix that quietly fell back to inference fails rather than coincidentally passing.
//
// Parity ledger: terminal.launch-profile-identity.

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const RECORDED_PROFILE = 'shell:git-bash-ops'

function registerSurface(leafIds: string[], activeLeafId: string): () => void {
  const paneIdByLeafId = new Map(leafIds.map((leafId, index) => [leafId, index + 1]))
  const manager = {
    getPanes: () => leafIds.map((leafId) => ({ id: paneIdByLeafId.get(leafId)!, leafId })),
    getActivePane: () => ({ id: paneIdByLeafId.get(activeLeafId)!, leafId: activeLeafId }),
    getLeafId: (paneId: number) =>
      leafIds.find((leafId) => paneIdByLeafId.get(leafId) === paneId) ?? null,
    getNumericIdForLeaf: (leafId: string) =>
      leafIds.includes(leafId) ? (paneIdByLeafId.get(leafId) ?? null) : null
  }
  return registerRuntimeTerminalTab({
    tabId: 'term-1',
    worktreeId: 'wt-1',
    getManager: () => manager as never,
    getContainer: () => null,
    getPtyIdForPane: (paneId) => `pty-${paneId}`,
    getTabWideAgentHintLeafId: () => leafIds[0] ?? null
  })
}

function stateWithTab(
  tab: Record<string, unknown>,
  layout: { leafIds: string[]; activeLeafId: string }
): AppState {
  const root =
    layout.leafIds.length === 1
      ? { type: 'leaf', leafId: layout.leafIds[0] }
      : {
          type: 'split',
          direction: 'row',
          children: layout.leafIds.map((leafId) => ({ type: 'leaf', leafId }))
        }
  return makeState({
    tabsByWorktree: {
      'wt-1': [{ id: 'term-1', title: 'Terminal 1', ...tab }]
    } as unknown as AppState['tabsByWorktree'],
    terminalLayoutsByTabId: {
      'term-1': {
        root,
        activeLeafId: layout.activeLeafId,
        expandedLeafId: null,
        ptyIdsByLeafId: Object.fromEntries(
          layout.leafIds.map((leafId, index) => [leafId, `pty-${index + 1}`])
        )
      }
    } as unknown as AppState['terminalLayoutsByTabId']
  })
}

describe('launch-profile provenance across the mobile projection', () => {
  it('WAS LOST — the recorded launch profile reaches the published row', () => {
    const unregister = registerSurface([LEAF_A], LEAF_A)
    try {
      const state = stateWithTab(
        { launchAgent: 'claude', launchProfileId: RECORDED_PROFILE },
        { leafIds: [LEAF_A], activeLeafId: LEAF_A }
      )

      const row = buildMobileSessionTabSnapshots(state)[0]?.tabs[0]

      expect(row).toMatchObject({ type: 'terminal', launchProfileId: RECORDED_PROFILE })
    } finally {
      unregister()
    }
  })

  it('what mobile derives from the published row is RECORDED, not the inference', () => {
    // The discriminator. Inference over this same row yields 'agent:claude'; only the
    // carried field can produce 'shell:git-bash-ops'. A fix that dropped the field and
    // let mobile guess would still answer with A SOURCE and A PROFILE, and this is what
    // refuses to accept that as the same thing.
    const unregister = registerSurface([LEAF_A], LEAF_A)
    try {
      const state = stateWithTab(
        { launchAgent: 'claude', launchProfileId: RECORDED_PROFILE },
        { leafIds: [LEAF_A], activeLeafId: LEAF_A }
      )

      const row = buildMobileSessionTabSnapshots(state)[0]?.tabs[0]
      const identity = resolveTerminalLaunchProfileIdentity({
        launchProfileId: (row as { launchProfileId?: string }).launchProfileId,
        launchAgent: (row as { launchAgent?: 'claude' }).launchAgent
      })

      expect(identity).toEqual({ source: 'recorded', profileId: RECORDED_PROFILE })
      expect(identity).not.toEqual({ source: 'inferred', profileId: 'agent:claude' })
    } finally {
      unregister()
    }
  })

  it('a row with no recorded profile still infers, and says that it inferred', () => {
    // The liveness control for the case above: inference is NOT deleted by this wave,
    // it is kept and kept distinguishable.
    const unregister = registerSurface([LEAF_A], LEAF_A)
    try {
      const state = stateWithTab(
        { launchAgent: 'claude' },
        { leafIds: [LEAF_A], activeLeafId: LEAF_A }
      )

      const row = buildMobileSessionTabSnapshots(state)[0]?.tabs[0]
      const identity = resolveTerminalLaunchProfileIdentity({
        launchProfileId: (row as { launchProfileId?: string }).launchProfileId,
        launchAgent: (row as { launchAgent?: 'claude' }).launchAgent
      })

      expect((row as { launchProfileId?: string }).launchProfileId).toBeUndefined()
      expect(identity).toEqual({ source: 'inferred', profileId: 'agent:claude' })
    } finally {
      unregister()
    }
  })

  it('a tab with nothing recorded stays UNKNOWN rather than taking a default', () => {
    const unregister = registerSurface([LEAF_A], LEAF_A)
    try {
      const state = stateWithTab({}, { leafIds: [LEAF_A], activeLeafId: LEAF_A })

      const row = buildMobileSessionTabSnapshots(state)[0]?.tabs[0]

      expect((row as { launchProfileId?: string }).launchProfileId).toBeUndefined()
      expect(resolveTerminalLaunchProfileIdentity({})).toEqual({ source: 'unknown' })
    } finally {
      unregister()
    }
  })

  it('a split pane does NOT inherit the tab launch profile', () => {
    // Same rule native-chat-leaf-routing already states for launchAgent: provenance
    // belongs to the tab's ORIGINAL pane, and once a split exists it is not evidence
    // about any particular sibling. A second pane the user opened later was not
    // launched from that profile, and must not claim it.
    const unregister = registerSurface([LEAF_A, LEAF_B], LEAF_A)
    try {
      const state = stateWithTab(
        { launchAgent: 'claude', launchProfileId: RECORDED_PROFILE },
        { leafIds: [LEAF_A, LEAF_B], activeLeafId: LEAF_A }
      )

      const rows = buildMobileSessionTabSnapshots(state)[0]?.tabs ?? []

      expect(rows.length).toBeGreaterThan(1)
      for (const row of rows) {
        expect((row as { launchProfileId?: string }).launchProfileId).toBeUndefined()
      }
    } finally {
      unregister()
    }
  })
})
