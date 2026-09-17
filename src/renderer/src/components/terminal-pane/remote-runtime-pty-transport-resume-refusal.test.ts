import { beforeEach, describe, expect, it } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import { withoutRuntimeAgentResume } from './remote-runtime-resume-refusal'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../../shared/setup-agent-sequencing'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const { runtimeCall, resetRemoteRuntimeTransport } = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

const HOST_AUTHORITY_STATUS = {
  ok: true,
  result: {
    runtimeProtocolVersion: 3,
    minCompatibleRuntimeClientVersion: 2,
    capabilities: ['agent-session.host-authority.v1']
  }
}

function hostRefusesEnsure(code: string) {
  runtimeCall.mockImplementation((args) => {
    if (args.method === 'status.get') {
      return Promise.resolve(HOST_AUTHORITY_STATUS)
    }
    if (args.method === 'terminal.ensureAgentSession') {
      return Promise.resolve({ ok: false, error: { code, message: code } })
    }
    if (args.method === 'terminal.create') {
      return Promise.resolve({
        ok: true,
        result: { terminal: { handle: 'terminal-plain', worktreeId: 'wt-1', title: null } }
      })
    }
    return Promise.resolve({ ok: true, result: {} })
  })
}

async function connectResumingPane() {
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'pane:1',
    command: "codex resume 'live-session'",
    launchAgent: 'codex',
    resumeProviderSession: { key: 'session_id', id: 'live-session' }
  })
  const result = await transport.connect({ url: '', callbacks: {} })
  return { transport, result }
}

describe('runtime pane resume refused by the host collision guard', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
    subscriptionCallbacks = null
  })

  it('opens a plain shell and says why, like the desktop gate', async () => {
    hostRefusesEnsure('agent_session_materializing')

    const { transport, result } = await connectResumingPane()

    expect(result).toMatchObject({ agentResumeRefused: 'materializing' })
    const creates = runtimeCall.mock.calls
      .map(([args]) => args)
      .filter((args) => args.method === 'terminal.create')
    expect(creates).toHaveLength(1)
    const params = creates[0]!.params as Record<string, unknown>
    for (const field of ['command', 'launchAgent', 'resumeProviderSession', 'launchConfig']) {
      expect(params, field).not.toHaveProperty(field)
    }
    transport.destroy?.()
  })

  it('never falls back to a plain shell for an error that is not a refusal', async () => {
    hostRefusesEnsure('agent_session_conflict')

    const { transport, result } = await connectResumingPane()

    expect(result).toBeUndefined()
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.create' })
    )
    transport.destroy?.()
  })
})

describe('withoutRuntimeAgentResume', () => {
  it('drops every launch field and the sequenced startup command, and keeps the rest', () => {
    expect(
      withoutRuntimeAgentResume({
        worktree: 'id:wt-1',
        command: 'claude --resume s',
        startupCommandDelivery: 'sequenced',
        launchConfig: { agentArgs: '', agentEnv: {} },
        resumeProviderSession: { key: 'session_id', id: 's' },
        launchToken: 'token',
        launchAgent: 'claude',
        env: { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: 'claude --resume s', KEEP: '1' },
        tabId: 'tab-1'
      })
    ).toEqual({ worktree: 'id:wt-1', env: { KEEP: '1' }, tabId: 'tab-1' })
  })
})
