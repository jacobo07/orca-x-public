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

function ensureCodexSession(runtime: OrcaRuntimeService, startupCwd?: string) {
  return runtime.ensureAgentSession({
    kind: 'explicit',
    worktree: 'id:worktree-1',
    agent: 'codex',
    providerSession: {
      key: 'session_id',
      id: '019f81b9-19a9-7651-a8d1-352d9420bd11',
      transcriptPath: CODEX_TRANSCRIPT
    },
    ...(startupCwd ? { startupCwd } : {})
  })
}

describe('ensureAgentSession execution context', () => {
  it('re-enters a subdirectory session in its own directory', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await ensureCodexSession(runtime, SESSION_CWD)

    const options = createTerminal.mock.calls[0]?.[1] as Record<string, unknown>
    expect(options.cwd).toBe(SESSION_CWD)
  })

  // Why: without a directory the workspace root is still the right answer — this is the
  // unchanged path every already-shipped caller takes.
  it('keeps the workspace root when no directory is named', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await ensureCodexSession(runtime)

    const options = createTerminal.mock.calls[0]?.[1] as Record<string, unknown>
    expect(Object.keys(options)).not.toContain('cwd')
  })

  it('refuses a directory outside the workspace instead of resuming there', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await expect(ensureCodexSession(runtime, '/tmp/somewhere-else')).rejects.toThrow(
      'agent_session_resume_context_unauthorized'
    )

    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('refuses a traversal that climbs out of the workspace', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await expect(ensureCodexSession(runtime, '../worktree-2/packages/web')).rejects.toThrow(
      'agent_session_resume_context_unauthorized'
    )

    expect(createTerminal).not.toHaveBeenCalled()
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

  // Why: the spawn layer decides the Codex account home from this subject and nothing else
  // (prepareCodexResumeHome), so handing it over IS the provenance. That the home then
  // reaches the process env is pinned one layer down, in the pty resume-provenance suite.
  it('hands the spawn layer the subject its account-home provenance is resolved from', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await ensureCodexSession(runtime)

    const options = createTerminal.mock.calls[0]?.[1] as {
      resumeProviderSession?: { id: string; transcriptPath?: string }
    }
    expect(options.resumeProviderSession).toMatchObject({
      id: '019f81b9-19a9-7651-a8d1-352d9420bd11',
      transcriptPath: CODEX_TRANSCRIPT
    })
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
