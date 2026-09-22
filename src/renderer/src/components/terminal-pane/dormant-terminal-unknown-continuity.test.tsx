// @vitest-environment happy-dom

/*
 * UNKNOWN CONTINUITY IS BEING RENDERED AS AN AFFIRMATIVE RESUME PROMISE.
 *
 * `shared/project-working-set-restore-time.ts` is the canonical continuity classifier, and it is
 * careful: a captured provider session whose transcript today's world could not confirm comes back
 * as `unknown` with reason `resume-unconfirmed`, never as `exact-resume`. The restore plan then
 * deliberately keeps `resumeOnOpen` true for that pane — "an unconfirmed resume is still worth
 * attempting when the user opens it" — which is a defensible product decision and not the defect.
 *
 * The defect is what happens next. `project-working-set-apply.ts` turns that pane into a
 * `SleepingAgentSessionRecord`, and that record carries no continuity field
 * (`shared/agent-session-resume.ts:43-77`), so the verdict is DROPPED at the store boundary. The
 * dormant surface reads the record, finds an agent, and tells the user "Opening it resumes the
 * claude session." — an affirmative claim of provider-session continuity, made from evidence that
 * says only "we will try".
 *
 * So the surface is not guessing badly. It is truthful about the only evidence it was handed, and
 * the evidence lost the one field that mattered one frame earlier. That is why this cannot be fixed
 * by editing a string: the surface has no field with which to be honest.
 *
 * CHARACTERIZATION, to be INVERTED IN PLACE when the fix lands, so the diff between two versions of
 * this file is the evidence rather than a new test beside a deleted one. Every `TODAY:` assertion
 * below asserts the wrong behaviour on purpose.
 *
 * The first case is not a characterization: it proves through the REAL planner that the state exists
 * at all. Without it the rest would be a test of a world production never enters.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as I18nModule from '@/i18n/i18n'
import { planWorkingSetRestore } from '../../../../shared/project-working-set-restore-plan'
import type { WorkingSetRestoreEvidence } from '../../../../shared/project-working-set-store-types'
import type { ProjectWorkingSetManifest } from '../../../../shared/project-working-set-types'
import { createStoreSessionMockApi } from '../../store/slices/store-session-test-harness'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
// Why: the assertion is about WHAT is claimed, and a locale would decide the words. The fallback is
// the copy the component itself ships, so this reads the component rather than a translation table.
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18nModule>()),
  translate: (_key: string, fallback: string, params?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => params?.[name] ?? `{{${name}}}`)
}))

createStoreSessionMockApi()

const { useAppStore } = await import('@/store')
const { applyWorkingSetRestorePlan, countWorkspaceOpenTabs } = await import(
  '@/lib/project-working-set-apply'
)
const { default: DormantTerminalSurface } = await import('./DormantTerminalPlaceholder')

const OWNER = 'repo-1::C:/work/orca'
const LEAF = '11111111-1111-4111-8111-111111111111'
const SOURCE_TAB = 'tab-unconfirmed'
const initialAppState = useAppStore.getInitialState()

/** One row that waits to be opened, holding one recorded Claude conversation. */
function manifest(): ProjectWorkingSetManifest {
  return {
    manifestVersion: 1,
    workingSetId: '0f8c6a52-3b1e-4d7a-9c2e-5a1b2c3d4e5f',
    label: 'unconfirmed-continuity',
    createdAt: 1_789_000_000_000,
    scope: {
      executionHostId: 'local',
      ownerKey: OWNER,
      location: { kind: 'repo-worktree', repoId: 'repo-1', worktreePath: 'C:/work/orca' }
    },
    railGroups: [[SOURCE_TAB]],
    revivalOrder: [],
    activeTabId: null,
    entries: [
      {
        tabId: SOURCE_TAB,
        label: 'Terminal',
        color: null,
        isPinned: false,
        launch: { launchProfileId: null, launchAgent: 'claude', shellOverride: null },
        startupCwd: null,
        activeLeafId: LEAF,
        restorePolicy: 'restore-on-open',
        panes: [
          {
            leafId: LEAF,
            title: null,
            scrollbackRef: 'scrollback-1',
            resume: {
              kind: 'provider-session',
              agent: 'claude',
              providerSession: { key: 'session_id', id: 'claude-session-a' },
              ompResumeFilePath: null
            }
          }
        ]
      }
    ]
  }
}

/**
 * The directory is there and the conversation is NOT. Not "proven deleted" — unreadable, which is
 * the ordinary case: another machine, a pruned cache, a provider home the probe could not reach.
 */
function unconfirmedEvidence(): WorkingSetRestoreEvidence {
  return {
    location: 'present',
    startupCwdByTabId: {},
    panes: {
      [`${SOURCE_TAB}:${LEAF}`]: { sealedScrollback: 'absent', transcript: 'unknown' }
    }
  }
}

let nextId = 0
function restoreOneRow() {
  useAppStore.setState({
    repos: [
      { id: 'repo-1', path: 'C:/work/orca', displayName: 'Orca', badgeColor: '#000', addedAt: 0 }
    ]
  } as never)
  const source = manifest()
  const plan = planWorkingSetRestore(source, {
    evidence: unconfirmedEvidence(),
    launchProfiles: [{ id: 'agent:claude' }],
    target: {
      executionHostId: 'local',
      ownerKey: OWNER,
      openTabCount: countWorkspaceOpenTabs(useAppStore.getState(), OWNER),
      hostAvailability: 'available'
    },
    presence: { [`${SOURCE_TAB}:${LEAF}`]: 'no-live-owner' },
    newTabId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`
  })
  const applied = applyWorkingSetRestorePlan(plan, {
    store: useAppStore,
    now: () => 1_000,
    newId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`
  })
  return { plan, applied }
}

let container: HTMLDivElement
let root: Root

describe('a dormant row whose continuity is UNKNOWN', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    useAppStore.setState(initialAppState, true)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
  })

  it('is reachable: the real planner produces unknown continuity that still resumes on open', () => {
    // Not a characterization. A guard written for a state no producer can build is a test of a world
    // production never enters, so this runs the real classifier through the real planner first.
    const { plan } = restoreOneRow()
    const pane = plan.entries[0].panes[0]

    expect(pane.restoreTime.capability).toBe('unknown')
    expect(pane.restoreTime.captured).toBe('exact-resume')
    expect(pane.restoreTime.reasons).toContain('resume-unconfirmed')
    // Deliberate and correct: only a proven-deleted conversation is never retried. The product
    // decision to attempt it is not the defect — claiming it will succeed is.
    expect(pane.resumeOnOpen).toBe(true)
  })

  it('TODAY: the verdict is dropped at the store boundary', () => {
    const { plan } = restoreOneRow()
    const state = useAppStore.getState()
    const targetTabId = plan.entries[0].targetTabId
    const record = Object.values(state.sleepingAgentSessionsByPaneKey).find(
      (candidate) => candidate.tabId === targetTabId
    )
    const tab = (state.tabsByWorktree[OWNER] ?? []).find((row) => row.id === targetTabId)

    // The record exists — so the surface sees an agent...
    expect(record?.agent).toBe('claude')
    // ...and nothing on the row says the classifier was unsure. INVERT: the dormancy marker must
    // carry the verdict, because it is the only thing that travels with the row.
    expect(record).not.toHaveProperty('continuity')
    expect(tab?.dormancy).toEqual({ reason: 'working-set-restore' })
  })

  it('TODAY: the surface promises an exact resume anyway', async () => {
    const { plan } = restoreOneRow()
    const targetTabId = plan.entries[0].targetTabId

    await act(async () => {
      root.render(<DormantTerminalSurface tabId={targetTabId} />)
    })
    const body = container.textContent ?? ''

    // Precondition, not decoration: if the agent branch had not rendered at all, the assertion below
    // would pass for the wrong reason.
    expect(container.querySelector('[data-dormant-terminal-tab-id]')).not.toBeNull()
    // `getAgentLabel` capitalizes, so the rendered word is the label, not the agent id.
    expect(body).toContain('Claude')

    // The defect, in the product's own words. INVERT: an unconfirmed conversation may be ATTEMPTED,
    // never promised — "Opening it resumes the Claude session." asserts continuity that the
    // canonical classifier explicitly declined to assert.
    expect(body).toContain('Opening it resumes the Claude session.')
  })
})
