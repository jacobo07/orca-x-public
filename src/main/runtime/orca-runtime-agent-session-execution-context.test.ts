import { describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import { OrcaRuntimeService } from './orca-runtime'

/** The workspace root the launch scope resolves to; every ensure spawn falls back to it. */
const WORKSPACE_PATH = '/tmp/worktree-1'
/** Where the session was actually started — a subdirectory of that root. */
const SESSION_CWD = '/tmp/worktree-1/packages/web'
/** The rollout file the host already receives, and the only pointer it needs to
 *  resolve which Codex account home this session belongs to. */
const CODEX_TRANSCRIPT =
  '/managed/codex-accounts/acct-a/home/sessions/2026/09/17/rollout-2026-09-17T10-00-00-019f81b9-19a9-7651-a8d1-352d9420bd11.jsonl'

function terminal() {
  return {
    handle: 'term_context',
    tabId: '11111111-1111-4111-8111-111111111111',
    paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
    ptyId: 'pty-context',
    worktreeId: 'worktree-1',
    title: null,
    surface: 'background' as const
  }
}

function createRuntime(agentDefaultEnv: Partial<Record<TuiAgent, Record<string, string>>> = {}) {
  const runtime = new OrcaRuntimeService(
    {
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv
      })
    } as never,
    undefined,
    {
      getLocalProvider: () =>
        ({
          supportsAgentSessionClaims: () => true,
          supportsAgentSessionCreateOperations: () => true
        }) as never
    }
  )
  const internal = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
    markLocalWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
    markRemoteWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
  }
  internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: 'worktree-1',
    path: WORKSPACE_PATH,
    connectionId: null
  }))
  internal.markLocalWorkspaceTrustedForAgent = vi.fn()
  internal.markRemoteWorkspaceTrustedForAgent = vi.fn()
  return runtime
}

function ensureCodexSession(runtime: OrcaRuntimeService) {
  return runtime.ensureAgentSession({
    kind: 'explicit',
    worktree: 'id:worktree-1',
    agent: 'codex',
    providerSession: {
      key: 'session_id',
      id: '019f81b9-19a9-7651-a8d1-352d9420bd11',
      transcriptPath: CODEX_TRANSCRIPT
    }
  })
}

describe('ensureAgentSession execution context', () => {
  // CHARACTERIZATION: ensure names no directory, so the spawn falls back to the workspace
  // root and a subdirectory session resumes in the wrong project context. Invert when the
  // request learns the session's own directory.
  it('materializes an existing session with no directory of its own', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await ensureCodexSession(runtime)

    const options = createTerminal.mock.calls[0]?.[1] as Record<string, unknown>
    expect(Object.keys(options)).not.toContain('cwd')
  })

  // Why: a positive control for the assertion above — the sibling create path passes this
  // exact property through the same boundary, so the absence above is the subject's.
  it('passes a startup directory through that same boundary when creating a session', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await runtime.createAgentSession({
      clientOperationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
      worktree: 'id:worktree-1',
      agent: 'codex',
      startupCwd: SESSION_CWD,
      presentation: 'background'
    })

    const options = createTerminal.mock.calls[0]?.[1] as Record<string, unknown>
    expect(options.cwd).toBe(SESSION_CWD)
  })

  // CHARACTERIZATION: the host holds the rollout path that names the session's account
  // home and still applies none of it — so an inherited CODEX_HOME survives and a
  // real-home session is never stripped. Invert when provenance reaches the spawn.
  it('applies no account-home provenance to a Codex session it can locate', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await ensureCodexSession(runtime)

    const options = createTerminal.mock.calls[0]?.[1] as { env?: Record<string, string> }
    expect(Object.keys(options)).not.toContain('envToDelete')
    expect(Object.keys(options.env ?? {})).not.toContain('CODEX_HOME')
    expect(Object.keys(options.env ?? {})).not.toContain('ORCA_CODEX_HOME')
  })

  // Why: proves the env assertion can see a variable at all — otherwise "no CODEX_HOME"
  // would pass against a boundary that never carries an environment.
  it('carries the host settings environment to that boundary', async () => {
    const runtime = createRuntime({ codex: { ORCA_TEST_MARKER: 'present' } })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await ensureCodexSession(runtime)

    const options = createTerminal.mock.calls[0]?.[1] as { env?: Record<string, string> }
    expect(options.env).toMatchObject({ ORCA_TEST_MARKER: 'present' })
  })
})
