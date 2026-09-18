import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

type Scope = { id: string; path: string; connectionId: string | null }

function createRuntime(scopes: Record<string, Scope>) {
  const runtime = new OrcaRuntimeService({ getSettings: () => ({}) } as never)
  const internal = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
  }
  internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async (selector: string) => {
    const scope = scopes[selector.replace(/^id:/, '')]
    if (!scope) {
      throw new Error('worktree_not_found')
    }
    return scope
  })
  return runtime
}

const scopes: Record<string, Scope> = {
  'project-a': { id: 'project-a', path: '/work/a', connectionId: null },
  'project-b': { id: 'project-b', path: '/work/b', connectionId: null },
  remote: { id: 'remote', path: '/srv/r', connectionId: 'ssh-1' }
}

const session = { key: 'session_id' as const, id: 'claude-session-a' }

describe('resolveAgentSessionPresenceKey', () => {
  it('gives one session the same key in two different projects', async () => {
    const runtime = createRuntime(scopes)

    const a = await runtime.resolveAgentSessionPresenceKey({
      worktreeId: 'project-a',
      agent: 'claude',
      providerSession: session
    })
    const b = await runtime.resolveAgentSessionPresenceKey({
      worktreeId: 'project-b',
      agent: 'claude',
      providerSession: session
    })

    expect(a).toEqual(expect.any(String))
    expect(a).toBe(b)
  })

  it('separates different sessions and different agents', async () => {
    const runtime = createRuntime(scopes)
    const base = await runtime.resolveAgentSessionPresenceKey({
      worktreeId: 'project-a',
      agent: 'claude',
      providerSession: session
    })

    const otherSession = await runtime.resolveAgentSessionPresenceKey({
      worktreeId: 'project-a',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'claude-session-b' }
    })
    const otherAgent = await runtime.resolveAgentSessionPresenceKey({
      worktreeId: 'project-a',
      agent: 'codex',
      providerSession: session
    })

    expect(otherSession).not.toBe(base)
    expect(otherAgent).not.toBe(base)
    expect(otherAgent).toEqual(expect.any(String))
  })

  it('cannot place an SSH workspace, so it answers null rather than a key', async () => {
    const runtime = createRuntime(scopes)

    await expect(
      runtime.resolveAgentSessionPresenceKey({
        worktreeId: 'remote',
        agent: 'claude',
        providerSession: session
      })
    ).resolves.toBeNull()
  })

  it('answers null for an unresolvable worktree or a non-resumable identity', async () => {
    const runtime = createRuntime(scopes)

    await expect(
      runtime.resolveAgentSessionPresenceKey({
        worktreeId: 'deleted',
        agent: 'claude',
        providerSession: session
      })
    ).resolves.toBeNull()
    await expect(
      runtime.resolveAgentSessionPresenceKey({
        worktreeId: 'project-a',
        agent: 'claude',
        providerSession: { key: 'session_id', id: '' }
      })
    ).resolves.toBeNull()
  })
})
