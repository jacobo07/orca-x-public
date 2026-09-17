import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebRuntimeSessionTerminal } from './web-runtime-session'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import {
  ENVIRONMENT_ID,
  FOCUS_LEAF_ID,
  WORKTREE_ID,
  makeSnapshot,
  resetTerminalCreateEnvironment,
  stubTerminalCreateEnvironment
} from './web-runtime-session-test-harness'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn(),
  setActiveWorktree: vi.fn(),
  createBrowserTab: vi.fn(),
  closeEmptyGroup: vi.fn(),
  moveUnifiedTabToGroup: vi.fn(),
  setRemoteBrowserPageHandle: vi.fn(),
  focusBrowserTabInWorktree: vi.fn(),
  applyFreshWebSessionTabsSnapshot: vi.fn(),
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('./web-session-tabs-sync', () => ({
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot,
  applyFreshWebSessionTabsSnapshot: mocks.applyFreshWebSessionTabsSnapshot,
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) =>
    mocks.setState(buildPatch),
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

vi.mock('./web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

/** A session recorded under a subdirectory of the workspace, which is the whole point:
 *  resuming it at the workspace root is a different project context. */
const SESSION_CWD = '/worktree/packages/web'
const PROVIDER_SESSION = { key: 'session_id' as const, id: 'session-ctx-1' }
/** A real-home Codex session: the launch must DROP an inherited home, not keep one. */
const CODEX_ENV_TO_DELETE = ['CODEX_HOME', 'ORCA_CODEX_HOME']

function makeRuntimeCall(capabilities: readonly string[]) {
  return vi.fn(async (request: { method: string }) => {
    if (request.method === 'status.get') {
      return {
        id: 'status',
        ok: true,
        result: {
          runtimeId: 'runtime-1',
          graphStatus: 'ready',
          runtimeProtocolVersion: 3,
          minCompatibleRuntimeClientVersion: 2,
          capabilities: [...capabilities]
        }
      }
    }
    if (
      request.method === 'terminal.ensureAgentSession' ||
      request.method === 'terminal.createAgentSession'
    ) {
      return {
        id: 'agent-session',
        ok: true,
        result: {
          terminal: {
            handle: 'term-ctx',
            worktreeId: WORKTREE_ID,
            tabId: 'host-tab-ctx',
            paneKey: `host-tab-ctx:${FOCUS_LEAF_ID}`
          },
          disposition: 'created'
        }
      }
    }
    if (request.method === 'session.tabs.createTerminal') {
      return {
        id: 'legacy-create',
        ok: true,
        result: { tab: { id: 'host-tab-legacy' }, publicationEpoch: 'epoch-1', snapshotVersion: 2 }
      }
    }
    return { id: 'list', ok: true, result: makeSnapshot() }
  })
}

function resumeSubdirectoryCodexSession(): Promise<{ status: string }> {
  return createWebRuntimeSessionTerminal({
    worktreeId: WORKTREE_ID,
    agentSessionKind: 'resume',
    launchAgent: 'codex',
    command: `cd '${SESSION_CWD}' && codex resume '${PROVIDER_SESSION.id}'`,
    providerSession: PROVIDER_SESSION,
    cwd: SESSION_CWD,
    envToDelete: CODEX_ENV_TO_DELETE,
    activate: false
  }) as Promise<{ status: string }>
}

function requestFor(
  runtimeCall: ReturnType<typeof makeRuntimeCall>,
  method: string
): { params: Record<string, unknown> } | undefined {
  return runtimeCall.mock.calls.find(([request]) => request.method === method)?.[0] as
    | { params: Record<string, unknown> }
    | undefined
}

describe('web AI Vault resume execution context', () => {
  beforeEach(() => {
    stubTerminalCreateEnvironment(mocks)
  })

  afterEach(() => {
    resetTerminalCreateEnvironment()
    resetWebSessionCloseIntentForTests()
  })

  // CHARACTERIZATION of today's defect: a subdirectory session resumes at the workspace
  // root because the guarded request carries no directory at all. Invert this the moment
  // ensure learns the session's own context — the diff is the evidence the fix landed.
  it('sends a guarded resume with no startup directory, so the host falls back to the workspace root', async () => {
    const runtimeCall = makeRuntimeCall(['agent-session.host-authority.v1'])
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    await expect(resumeSubdirectoryCodexSession()).resolves.toEqual({ status: 'created' })

    const ensure = requestFor(runtimeCall, 'terminal.ensureAgentSession')
    expect(ensure).toBeDefined()
    expect(Object.keys(ensure!.params)).not.toContain('startupCwd')
    expect(Object.keys(ensure!.params)).not.toContain('envToDelete')
  })

  // Why: proves the case above is a DROP at the guarded boundary, not context the client
  // never had — the same call hands all three fields to the unguarded leg.
  it('hands the unguarded leg the very context the guarded request omits', async () => {
    const runtimeCall = makeRuntimeCall([])
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    await expect(resumeSubdirectoryCodexSession()).resolves.toEqual({ status: 'created' })

    expect(requestFor(runtimeCall, 'terminal.ensureAgentSession')).toBeUndefined()
    expect(requestFor(runtimeCall, 'session.tabs.createTerminal')!.params).toMatchObject({
      cwd: SESSION_CWD,
      envToDelete: CODEX_ENV_TO_DELETE
    })
  })

  // Why: a positive control for the assertion itself — the sibling create path already
  // carries a startup directory over this same wire, so a red above is the subject failing.
  it('carries a startup directory on the sibling create path', async () => {
    const runtimeCall = makeRuntimeCall(['agent-session.host-authority.v1'])
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        agentSessionKind: 'create',
        launchAgent: 'codex',
        cwd: SESSION_CWD,
        activate: false
      })
    ).resolves.toEqual({ status: 'created' })

    expect(requestFor(runtimeCall, 'terminal.createAgentSession')!.params).toMatchObject({
      startupCwd: SESSION_CWD
    })
  })
})
