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
 * INVERTED IN PLACE (c3502a0b1). This file first asserted the defect — `{ reason:
 * 'working-set-restore' }` with no verdict on the row, and "Opening it resumes the Claude session."
 * rendered verbatim — so the diff between the two versions is the evidence, rather than a new test
 * beside a deleted one. The fix carries the verdict on the dormancy marker, which is the only thing
 * that travels with a restored row, and the surface reads it.
 *
 * The first case is not a characterization: it proves through the REAL planner that the state exists
 * at all. Without it the rest would be a test of a world production never enters. The exact-resume
 * case is the other half of the same requirement — a row that had simply stopped saying anything
 * satisfies every "does not promise" assertion here and looks exactly like the fix working.
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
 * The directory is there; the conversation is whatever the case says.
 *
 * `unknown` is not "proven deleted" — it is unreadable, which is the ordinary case: another machine,
 * a pruned cache, a provider home the probe could not reach.
 */
function evidenceWith(transcript: 'present' | 'absent' | 'unknown'): WorkingSetRestoreEvidence {
  return {
    location: 'present',
    startupCwdByTabId: {},
    panes: {
      [`${SOURCE_TAB}:${LEAF}`]: { sealedScrollback: 'absent', transcript }
    }
  }
}

let nextId = 0
function restoreOneRow(
  transcript: 'present' | 'absent' | 'unknown' = 'unknown',
  presence: 'no-live-owner' | 'live-elsewhere' = 'no-live-owner'
) {
  useAppStore.setState({
    repos: [
      { id: 'repo-1', path: 'C:/work/orca', displayName: 'Orca', badgeColor: '#000', addedAt: 0 }
    ]
  } as never)
  const source = manifest()
  const plan = planWorkingSetRestore(source, {
    evidence: evidenceWith(transcript),
    launchProfiles: [{ id: 'agent:claude' }],
    target: {
      executionHostId: 'local',
      ownerKey: OWNER,
      openTabCount: countWorkspaceOpenTabs(useAppStore.getState(), OWNER),
      hostAvailability: 'available'
    },
    presence: { [`${SOURCE_TAB}:${LEAF}`]: presence },
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

async function renderRow(targetTabId: string): Promise<{ body: string; continuity: string | null }> {
  await act(async () => {
    root.render(<DormantTerminalSurface tabId={targetTabId} />)
  })
  const host = container.querySelector('[data-dormant-terminal-tab-id]')
  // Precondition, not decoration: with nothing rendered, every "does not say" assertion below would
  // pass for the wrong reason.
  expect(host, 'the dormant row rendered nothing').not.toBeNull()
  return {
    body: container.textContent ?? '',
    continuity: host!.getAttribute('data-resume-continuity')
  }
}

/** `getAgentLabel` capitalizes, so this is the word the user actually reads. */
const PROMISE = 'Opening it resumes the Claude session.'

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

  it('carries the verdict across the store boundary', () => {
    // INVERTED. This asserted `{ reason: 'working-set-restore' }` and nothing else: the classifier
    // said `unknown`, apply wrote a resume handle, and the verdict stopped there.
    const { plan } = restoreOneRow()
    const state = useAppStore.getState()
    const targetTabId = plan.entries[0].targetTabId
    const record = Object.values(state.sleepingAgentSessionsByPaneKey).find(
      (candidate) => candidate.tabId === targetTabId
    )
    const tab = (state.tabsByWorktree[OWNER] ?? []).find((row) => row.id === targetTabId)

    // The handle is still written — an unconfirmed resume is still attempted, unchanged.
    expect(record?.agent).toBe('claude')
    expect(tab?.dormancy).toEqual({
      reason: 'working-set-restore',
      resumeContinuity: 'unconfirmed'
    })
  })

  it('offers the row without promising the conversation', async () => {
    // INVERTED. This asserted the promise, verbatim, as the defect.
    const { plan } = restoreOneRow()
    const { body, continuity } = await renderRow(plan.entries[0].targetTabId)

    expect(continuity).toBe('unconfirmed')
    expect(body).toContain('Claude')
    expect(body).not.toContain(PROMISE)
    // Still offered, and honest about both halves of what may happen.
    expect(body).toContain('will try to resume')
    expect(body).toContain('could not be confirmed')
  })

  it('promises the conversation when today confirmed it', async () => {
    // The control. Without it, a row that had simply stopped saying anything would satisfy every
    // "does not promise" assertion above and look exactly like the fix working.
    const { plan } = restoreOneRow('present')
    expect(plan.entries[0].panes[0].restoreTime.capability).toBe('exact-resume')

    const { body, continuity } = await renderRow(plan.entries[0].targetTabId)
    expect(continuity).toBe('exact')
    expect(body).toContain(PROMISE)
  })

  it('says the session is taken rather than offering a silent fresh terminal', async () => {
    // Apply deliberately writes no resume handle for a session live elsewhere, so before the marker
    // carried the verdict this row read as an ordinary new terminal and the collision went unsaid.
    const { plan } = restoreOneRow('present', 'live-elsewhere')
    expect(plan.entries[0].panes[0].blockers).toContain('live-elsewhere')

    const { body, continuity } = await renderRow(plan.entries[0].targetTabId)
    expect(continuity).toBe('claimed-elsewhere')
    expect(body).toContain('open somewhere else')
    expect(body).not.toContain(PROMISE)
  })

  it('withholds the promise from a row no classifier ever judged', async () => {
    // A row persisted before the marker carried a verdict, or one an explicit workspace sleep
    // created — sleep records a live handle without asking whether the conversation can still be
    // found. Absent is unknown, and unknown may not promise.
    const { plan } = restoreOneRow()
    const targetTabId = plan.entries[0].targetTabId
    useAppStore.setState({
      tabsByWorktree: {
        [OWNER]: (useAppStore.getState().tabsByWorktree[OWNER] ?? []).map((row) =>
          row.id === targetTabId ? { ...row, dormancy: { reason: 'workspace-sleep' as const } } : row
        )
      }
    } as never)

    const { body, continuity } = await renderRow(targetTabId)
    expect(continuity).toBe('unconfirmed')
    expect(body).not.toContain(PROMISE)
    expect(body).toContain('will try to resume')
  })
})
